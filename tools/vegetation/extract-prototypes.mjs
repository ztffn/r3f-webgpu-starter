#!/usr/bin/env node

/**
 * Extracts normalized tree prototypes from an ingested vegetation pack.
 *
 * The stage the prepare-vegetation README calls "normalize/pivot each selected prefab":
 * pairs trunk and branch nodes by co-location in the pack's sample scene, bakes the
 * world transforms into the vertices, moves each tree's base to the origin, scales it
 * to UNIT HEIGHT (the species table's heightMetres is the one place size is authored),
 * and writes ONE prototypes.glb — two primitives per tree, opaque trunk and alpha-MASK
 * leaves — plus a manifest with attribution and the unit-space measurements a species
 * record needs. Deterministic, and everything it writes is regenerable from the source.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";

const DEFAULT_INPUT = path.resolve("_tempAssets/3d/_Vegetation/low_poly_forest_tree_pack.glb");
const DEFAULT_OUTPUT = path.resolve("public/assets/vegetation/prototypes");

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--input") args.input = path.resolve(argv[++i]);
    else if (value === "--output") args.output = path.resolve(argv[++i]);
    else if (value === "--help" || value === "-h") {
      console.log("Usage: node tools/vegetation/extract-prototypes.mjs [--input pack.glb] [--output dir]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Normal transform: inverse-transpose of the upper 3x3, applied then renormalised.
 * The packs carry uniform-ish scales, but Sketchfab exports route them through the
 * node hierarchy, so assuming identity here would silently shear every normal.
 */
function invertTranspose3(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det =
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inv = 1 / det;
  // inverse (cofactor / det), already laid out transposed for direct use on normals
  return [
    (a[4] * a[8] - a[5] * a[7]) * inv,
    (a[2] * a[7] - a[1] * a[8]) * inv,
    (a[1] * a[5] - a[2] * a[4]) * inv,
    (a[5] * a[6] - a[3] * a[8]) * inv,
    (a[0] * a[8] - a[2] * a[6]) * inv,
    (a[2] * a[3] - a[0] * a[5]) * inv,
    (a[3] * a[7] - a[4] * a[6]) * inv,
    (a[1] * a[6] - a[0] * a[7]) * inv,
    (a[0] * a[4] - a[1] * a[3]) * inv,
  ];
}

/** Gathers a node's primitives into flat world-space arrays. */
function bakeNode(node) {
  const mesh = node.getMesh();
  const world = node.getWorldMatrix();
  const normalMatrix = invertTranspose3(world);
  const positions = [];
  const normals = [];
  const uvs = [];
  for (const primitive of mesh.listPrimitives()) {
    const pos = primitive.getAttribute("POSITION");
    const nrm = primitive.getAttribute("NORMAL");
    const uv = primitive.getAttribute("TEXCOORD_0");
    const indices = primitive.getIndices();
    const count = indices ? indices.getCount() : pos.getCount();
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    const t = [0, 0];
    for (let i = 0; i < count; i += 1) {
      const v = indices ? indices.getScalar(i) : i;
      pos.getElement(v, p);
      const wp = transformPoint(world, p[0], p[1], p[2]);
      positions.push(wp[0], wp[1], wp[2]);
      if (nrm) {
        nrm.getElement(v, n);
        const m = normalMatrix;
        const nx = m[0] * n[0] + m[1] * n[1] + m[2] * n[2];
        const ny = m[3] * n[0] + m[4] * n[1] + m[5] * n[2];
        const nz = m[6] * n[0] + m[7] * n[1] + m[8] * n[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        normals.push(nx / l, ny / l, nz / l);
      } else {
        normals.push(0, 1, 0);
      }
      if (uv) {
        uv.getElement(v, t);
        uvs.push(t[0], t[1]);
      } else {
        uvs.push(0, 0);
      }
    }
  }
  return { positions, normals, uvs, material: mesh.listPrimitives()[0]?.getMaterial() ?? null };
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const v = positions[i + axis];
      if (v < min[axis]) min[axis] = v;
      if (v > max[axis]) max[axis] = v;
    }
  }
  return { min, max };
}

const args = parseArgs(process.argv.slice(2));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(args.input);
const root = document.getRoot();
const asset = root.getAsset();
const attribution = asset?.extras ?? {};
if (!attribution.license || !attribution.source) {
  throw new Error("Source GLB carries no licence/source metadata; refusing to extract");
}

// --- Pair trunks with branch crowns by horizontal co-location ---------------
const trunkNodes = [];
const branchNodes = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const name = `${node.getName()} ${mesh.getName()}`;
  if (/trunk/i.test(name)) trunkNodes.push(node);
  else if (/branch/i.test(name)) branchNodes.push(node);
}
if (trunkNodes.length === 0) throw new Error("No trunk nodes found");

const pairs = [];
for (const trunk of trunkNodes) {
  const baked = bakeNode(trunk);
  const b = boundsOf(baked.positions);
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  let best = null;
  let bestDistance = Infinity;
  for (const branches of branchNodes) {
    const bb = boundsOf(bakeNode(branches).positions);
    const d = Math.hypot((bb.min[0] + bb.max[0]) / 2 - cx, (bb.min[2] + bb.max[2]) / 2 - cz);
    if (d < bestDistance) {
      bestDistance = d;
      best = branches;
    }
  }
  if (!best || bestDistance > 3) {
    console.warn(`No crown within 3 m of ${trunk.getName()}; skipping`);
    continue;
  }
  pairs.push({ trunk, branches: best });
}

// Tallest first, so prototype ids stay stable if the pack gains small extras later.
const measured = pairs.map((pair) => {
  const trunk = bakeNode(pair.trunk);
  const branches = bakeNode(pair.branches);
  const all = boundsOf([...trunk.positions, ...branches.positions]);
  return { ...pair, trunkData: trunk, branchData: branches, height: all.max[1] - all.min[1] };
});
measured.sort((a, b) => b.height - a.height);

// --- Build the output document: one mesh per tree, trunk + leaves primitives ---
const buffer = root.listBuffers()[0];
const scene = document.createScene("prototypes");
const manifestEntries = [];

function makePrimitive(data, offsetX, baseY, offsetZ, scale, material) {
  const count = data.positions.length / 3;
  const positions = new Float32Array(data.positions.length);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (data.positions[i * 3] - offsetX) * scale;
    positions[i * 3 + 1] = (data.positions[i * 3 + 1] - baseY) * scale;
    positions[i * 3 + 2] = (data.positions[i * 3 + 2] - offsetZ) * scale;
  }
  const primitive = document.createPrimitive();
  primitive.setAttribute(
    "POSITION",
    document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer)
  );
  primitive.setAttribute(
    "NORMAL",
    document.createAccessor().setType("VEC3").setArray(new Float32Array(data.normals)).setBuffer(buffer)
  );
  primitive.setAttribute(
    "TEXCOORD_0",
    document.createAccessor().setType("VEC2").setArray(new Float32Array(data.uvs)).setBuffer(buffer)
  );
  primitive.setMaterial(material);
  return primitive;
}

let index = 0;
for (const tree of measured) {
  index += 1;
  const id = `forest-tree-${String(index).padStart(2, "0")}`;
  const trunkBounds = boundsOf(tree.trunkData.positions);
  const allBounds = boundsOf([...tree.trunkData.positions, ...tree.branchData.positions]);
  const baseY = allBounds.min[1];
  const offsetX = (trunkBounds.min[0] + trunkBounds.max[0]) / 2;
  const offsetZ = (trunkBounds.min[2] + trunkBounds.max[2]) / 2;
  const height = allBounds.max[1] - baseY;
  const scale = 1 / height;

  // The leaf material converts to MASK here — glTF BLEND would put every crown in the
  // transparent queue and make cover order-dependent, the exact failure the foliage
  // material's header documents. The cutoff matches FOLIAGE_ALPHA_CUTOFF.
  // Only the base colour survives: the runtime tree material is baseColor + our own
  // lighting, so normal/roughness/emissive maps would be megabytes of dead weight.
  const stripExtras = (material) =>
    material
      .setNormalTexture(null)
      .setMetallicRoughnessTexture(null)
      .setOcclusionTexture(null)
      .setEmissiveTexture(null);
  const trunkMaterial = stripExtras(
    tree.trunkData.material.clone().setName(`${id}-trunk`).setAlphaMode("OPAQUE").setDoubleSided(true)
  );
  const leafMaterial = stripExtras(
    tree.branchData.material
      .clone()
      .setName(`${id}-leaves`)
      .setAlphaMode("MASK")
      .setAlphaCutoff(0.5)
      .setDoubleSided(true)
  );

  const mesh = document.createMesh(id);
  mesh.addPrimitive(makePrimitive(tree.trunkData, offsetX, baseY, offsetZ, scale, trunkMaterial));
  mesh.addPrimitive(makePrimitive(tree.branchData, offsetX, baseY, offsetZ, scale, leafMaterial));
  const node = document.createNode(id).setMesh(mesh);
  scene.addChild(node);

  // Unit-space measurements for the species record. Crown radius uses leaf vertices'
  // horizontal reach from the trunk axis; the trunk cylinder comes from trunk bounds.
  let crownRadius = 0;
  let crownBase = Infinity;
  for (let i = 0; i < tree.branchData.positions.length; i += 3) {
    const dx = tree.branchData.positions[i] - offsetX;
    const dy = tree.branchData.positions[i + 1] - baseY;
    const dz = tree.branchData.positions[i + 2] - offsetZ;
    crownRadius = Math.max(crownRadius, Math.hypot(dx, dz));
    crownBase = Math.min(crownBase, dy);
  }
  manifestEntries.push({
    id,
    sourceNodes: [tree.trunk.getName(), tree.branches.getName()],
    authoredHeightMetres: Number(height.toFixed(3)),
    unit: {
      crownRadius: Number((crownRadius * scale).toFixed(4)),
      crownBase: Number((crownBase * scale).toFixed(4)),
      trunkRadius: Number(
        ((Math.max(trunkBounds.max[0] - trunkBounds.min[0], trunkBounds.max[2] - trunkBounds.min[2]) / 2) * scale).toFixed(4)
      ),
      trunkHeight: Number(((trunkBounds.max[1] - baseY) * scale).toFixed(4)),
    },
    triangles: (tree.trunkData.positions.length + tree.branchData.positions.length) / 9,
  });
}

// Drop the pack's sample scene so prune() removes everything the prototypes do not
// reference — including the 13 background-card trees and the rock textures.
for (const oldScene of root.listScenes()) {
  if (oldScene !== scene) oldScene.dispose();
}
root.setDefaultScene(scene);
await document.transform(prune());

await fs.mkdir(args.output, { recursive: true });
const glbPath = path.join(args.output, "prototypes.glb");
await io.write(glbPath, document);
const manifest = {
  schema: "df2.vegetation-prototypes/v1",
  source: {
    file: path.basename(args.input),
    title: attribution.title ?? null,
    author: attribution.author ?? null,
    license: attribution.license,
    url: attribution.source,
  },
  normalisation: "unit height, base at origin, trunk axis at x=z=0; species.heightMetres restores metres",
  prototypes: manifestEntries,
};
await fs.writeFile(path.join(args.output, "prototypes-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const bytes = (await fs.stat(glbPath)).size;
console.log(`Wrote ${manifestEntries.length} prototypes (${(bytes / 1048576).toFixed(2)} MiB) to ${args.output}`);
for (const entry of manifestEntries) {
  console.log(
    `  ${entry.id}: authored ${entry.authoredHeightMetres} m, crown r=${entry.unit.crownRadius} base=${entry.unit.crownBase}, ` +
      `trunk r=${entry.unit.trunkRadius} h=${entry.unit.trunkHeight}, ${entry.triangles} tris`
  );
}
