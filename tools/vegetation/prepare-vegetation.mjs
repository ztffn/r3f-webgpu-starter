#!/usr/bin/env node

/**
 * Offline vegetation ingest.
 *
 * This tool deliberately has no browser, React, or Three.js dependency. It turns one or
 * more downloaded GLBs into optimized runtime packs and a renderer-independent manifest.
 * The manifest is the seam shared by the cell renderer, analytic foliage query, and a
 * future server authority; visual LODs never change the collider records.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";

const DEFAULT_INPUT = path.resolve("_tempAssets/3d/_Vegetation");
const DEFAULT_OUTPUT = path.resolve("public/assets/vegetation");

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--input") args.input = path.resolve(argv[++i]);
    else if (value === "--output") args.output = path.resolve(argv[++i]);
    else if (value === "--help" || value === "-h") {
      console.log("Usage: npm run prepare:vegetation -- [--input path] [--output path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function slug(value) {
  return value
    .replace(/\.glb$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function classify(name) {
  const lower = name.toLowerCase();
  if (/trunk|bark|tree/.test(lower)) return "tree";
  if (/rock|stone/.test(lower)) return "rock";
  if (/grass|bush|flower|lavender|plant|fern|shrub/.test(lower)) return "undergrowth";
  return "unknown";
}

function matrixPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function boundsForNode(node) {
  const mesh = node.getMesh();
  if (!mesh) return null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let vertices = 0;
  const matrix = node.getWorldMatrix();

  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute("POSITION");
    if (!position) continue;
    const pMin = position.getMin([0, 0, 0]);
    const pMax = position.getMax([0, 0, 0]);
    vertices += position.getCount();
    const indices = primitive.getIndices();
    triangles += Math.floor((indices ? indices.getCount() : position.getCount()) / 3);
    for (const x of [pMin[0], pMax[0]]) {
      for (const y of [pMin[1], pMax[1]]) {
        for (const z of [pMin[2], pMax[2]]) {
          const transformed = matrixPoint(matrix, [x, y, z]);
          for (let axis = 0; axis < 3; axis += 1) {
            min[axis] = Math.min(min[axis], transformed[axis]);
            max[axis] = Math.max(max[axis], transformed[axis]);
          }
        }
      }
    }
  }

  if (!Number.isFinite(min[0])) return null;
  const size = max.map((value, axis) => value - min[axis]);
  const centre = max.map((value, axis) => (value + min[axis]) * 0.5);
  return { min, max, size, centre, vertices, triangles };
}

function colliderFor(kind, name, bounds) {
  if (kind === "tree" && /trunk|bark/.test(name.toLowerCase())) {
    // The longest axis is the authored trunk height. This is a proposal for gameplay
    // tuning, not a claim that the visual mesh is authoritative geometry.
    const heightAxis = bounds.size.indexOf(Math.max(...bounds.size));
    const horizontal = bounds.size.filter((_, axis) => axis !== heightAxis);
    const radius = Math.max(...horizontal) * 0.5;
    return {
      shape: "cylinder",
      radiusMetres: Number(radius.toFixed(4)),
      heightMetres: Number(bounds.size[heightAxis].toFixed(4)),
      surfaceId: "wood",
      // Matches the foliage prototype's convention: a trunk's diameter is the
      // gameplay path thickness, independent of render LOD.
      penetrationThicknessMetres: Number(Math.max(radius * 2, 0.05).toFixed(4)),
      review: "validate against the authored species balance before enabling gunplay",
    };
  }

  if (kind === "rock") {
    return {
      shape: "box",
      sizeMetres: bounds.size.map((value) => Number(value.toFixed(4))),
      surfaceId: "stone",
      penetrationThicknessMetres: Number(Math.max(...bounds.size).toFixed(4)),
      review: "optional static cover collider; do not register every decorative rock by default",
    };
  }

  return null;
}

function summarizeDocument(document, sourceName) {
  const prototypes = [];
  let vertices = 0;
  let triangles = 0;

  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const nodeName = node.getName() || mesh.getName() || `mesh-${prototypes.length}`;
    const kind = classify(`${nodeName} ${mesh.getName()}`);
    const bounds = boundsForNode(node);
    if (!bounds) continue;
    vertices += bounds.vertices;
    triangles += bounds.triangles;
    prototypes.push({
      id: `${slug(sourceName)}:${slug(nodeName)}`,
      source: sourceName,
      name: nodeName,
      mesh: mesh.getName() || null,
      kind,
      vertices: bounds.vertices,
      triangles: bounds.triangles,
      bounds: {
        min: bounds.min.map((value) => Number(value.toFixed(4))),
        max: bounds.max.map((value) => Number(value.toFixed(4))),
        size: bounds.size.map((value) => Number(value.toFixed(4))),
      },
      collider: colliderFor(kind, nodeName, bounds),
    });
  }

  return { vertices, triangles, prototypes };
}

async function inputFiles(input) {
  const stat = await fs.stat(input);
  if (stat.isFile()) return [input];
  return (await fs.readdir(input))
    .filter((name) => name.toLowerCase().endsWith(".glb"))
    .sort()
    .map((name) => path.join(input, name));
}

async function main() {
  const { input, output } = parseArgs(process.argv.slice(2));
  const files = await inputFiles(input);
  if (files.length === 0) throw new Error(`No GLB files found at ${input}`);

  await fs.mkdir(output, { recursive: true });
  await MeshoptEncoder.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const sources = [];
  const allPrototypes = [];

  for (const file of files) {
    const sourceName = path.basename(file);
    const sourceSlug = slug(sourceName);
    const originalBytes = (await fs.stat(file)).size;
    const document = await io.read(file);
    const summary = summarizeDocument(document, sourceName);

    await document.transform(
      dedup(),
      prune(),
      meshopt({ encoder: MeshoptEncoder, level: "medium" })
    );

    const outputName = `${sourceSlug}.runtime.glb`;
    const outputFile = path.join(output, outputName);
    await io.write(outputFile, document);
    const optimizedBytes = (await fs.stat(outputFile)).size;

    sources.push({
      id: sourceSlug,
      sourceFile: sourceName,
      runtimeFile: outputName,
      originalBytes,
      optimizedBytes,
      asset: document.getRoot().getAsset() ?? null,
      vertices: summary.vertices,
      triangles: summary.triangles,
      prototypeCount: summary.prototypes.length,
    });
    allPrototypes.push(...summary.prototypes);
    console.log(
      `${sourceName}: ${summary.triangles.toLocaleString()} triangles, ` +
        `${(originalBytes / 1048576).toFixed(1)} MiB → ${(optimizedBytes / 1048576).toFixed(1)} MiB`
    );
  }

  const manifest = {
    schema: "df2.vegetation-manifest/v1",
    sourceDirectory: path.relative(process.cwd(), input),
    runtimeContract: {
      instancing: "cell-local",
      lod: ["authored-near", "authored-mid", "foliage-cards", "impostor"],
      impostor: "provided by the foliage renderer; not baked into source GLBs",
      gameplay: "renderer-independent collider records; never derive bullet collision from render LOD",
    },
    colliderPolicy: {
      tree: "analytic vertical cylinder, normally consumed by VegetationWorldQuery",
      rock: "optional static box cover, registered only when gameplay requires it",
      undergrowth: "no bullet collider; concealment remains a separate query",
      authoritativeSurface: "surfaceId and penetrationThicknessMetres are data, not material inference",
    },
    sources,
    prototypes: allPrototypes,
  };
  await fs.writeFile(
    path.join(output, "vegetation-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  console.log(`Wrote ${path.join(output, "vegetation-manifest.json")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
