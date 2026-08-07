#!/usr/bin/env node

/**
 * Offline hemi-octahedral impostor bake for the far foliage ring.
 *
 * Renders each species' LOD 0 card geometry from a grid of views into albedo and
 * normal+depth atlases (src/foliage/impostorBake.ts does the actual rasterising) and
 * writes PNGs plus a manifest into public/assets/vegetation/impostors/. Deterministic:
 * same source, byte-identical output. Run via `npm run bake:impostors` — the script
 * needs Node's --experimental-strip-types because the shared modules are TypeScript.
 *
 * The PNGs look upside-down in an image viewer ON PURPOSE: atlas row 0 is the plant's
 * BASE (uv v = 0), and it is written as the top scanline so decode → upload needs no row
 * flip anywhere in the chain. A flip that exists only in viewers is cheaper than one
 * that has to be remembered in code.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  FOLIAGE_ALPHA_CUTOFF,
  FOLIAGE_IMPOSTOR_ALPHA_CUTOFF,
} from "../../src/foliage/foliageConfig.ts";
import { bakeImpostorAtlas } from "../../src/foliage/impostorBake.ts";
import { decodePng, encodePng } from "../../src/foliage/impostorPng.ts";
import { impostorBakeOptionsFor } from "../../src/foliage/impostorSource.ts";
import { SPECIES } from "../../src/foliage/species.ts";

const PROTOTYPES_DIR = path.resolve("public/assets/vegetation/prototypes");

const DEFAULT_OUTPUT = path.resolve("public/assets/vegetation/impostors");

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    spritesPerSide: 12,
    tileSize: 170,
    supersample: 2,
    variant: "B",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--output") args.output = path.resolve(argv[++i]);
    else if (value === "--sprites") args.spritesPerSide = Number(argv[++i]);
    else if (value === "--tile") args.tileSize = Number(argv[++i]);
    else if (value === "--supersample") args.supersample = Number(argv[++i]);
    else if (value === "--variant") args.variant = argv[++i];
    else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: npm run bake:impostors -- [--output path] [--sprites n] [--tile px] [--supersample n] [--variant A|B|C|D]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function horizonStats(tileCoverage, n) {
  const values = [];
  for (let k = 0; k < n; k += 1) {
    for (const index of [k, (n - 1) * n + k, k * n, k * n + (n - 1)]) {
      const coverage = tileCoverage[index];
      if (Number.isFinite(coverage) && !values.includes(coverage)) values.push(coverage);
    }
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { mean, min: Math.min(...values) };
}

/**
 * Bake options for an authored prototype: geometry from prototypes.glb scaled to the
 * species' height, colour sampled from the pack's own textures, and the coverage audit
 * measured over the MANIFEST's crown (crownOf() derives a crown for procedural card
 * plants and knows nothing about an authored silhouette).
 */
async function prototypeBakeOptions(species, args, prototypes) {
  const { document, manifest } = prototypes;
  const mesh = document
    .getRoot()
    .listMeshes()
    .find((candidate) => candidate.getName() === species.prototype);
  const entry = manifest.prototypes.find((p) => p.id === species.prototype);
  if (!mesh || !entry) throw new Error(`prototype ${species.prototype} not found`);

  const h = species.heightMetres;
  const positions = [];
  const normals = [];
  const uvs = [];
  const leaf = [];
  let leafTexture = null;
  let barkTexture = null;
  for (const primitive of mesh.listPrimitives()) {
    const material = primitive.getMaterial();
    const isLeaf = material.getName().endsWith("-leaves") ? 1 : 0;
    const image = material.getBaseColorTexture().getImage();
    const decoded = await decodePng(new Uint8Array(image));
    if (isLeaf) leafTexture = decoded;
    else barkTexture = decoded;

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
      positions.push(p[0] * h, p[1] * h, p[2] * h);
      nrm.getElement(v, n);
      normals.push(n[0], n[1], n[2]);
      uv.getElement(v, t);
      uvs.push(t[0], t[1]);
      leaf.push(isLeaf);
    }
  }
  if (!leafTexture || !barkTexture) throw new Error(`${species.prototype}: missing textures`);

  // Alpha-weighted mean leaf colour, linear — the dilation fill for uncovered texels,
  // so filtered silhouette edges pull leaf-green instead of black.
  const srgb = (byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < leafTexture.data.length; i += 4) {
    const a = leafTexture.data[i + 3];
    r += srgb(leafTexture.data[i]) * a;
    g += srgb(leafTexture.data[i + 1]) * a;
    b += srgb(leafTexture.data[i + 2]) * a;
    weight += a;
  }
  const leafColor = weight > 0 ? [r / weight, g / weight, b / weight] : [0.3, 0.4, 0.25];

  return {
    mesh: {
      position: new Float32Array(positions),
      normal: new Float32Array(normals),
      uv: new Float32Array(uvs),
      leaf: new Float32Array(leaf),
    },
    leafTexture,
    barkTexture,
    leafColor,
    barkColor: [0.19, 0.15, 0.11],
    alphaCutoff: FOLIAGE_ALPHA_CUTOFF,
    spritesPerSide: args.spritesPerSide,
    tileSize: args.tileSize,
    supersample: args.supersample,
    crown: {
      radiusMetres: species.radiusMetres,
      baseY: entry.unit.crownBase * h,
      topY: h,
    },
  };
}

const args = parseArgs(process.argv.slice(2));
await fs.mkdir(args.output, { recursive: true });

let prototypes = null;
if (SPECIES.some((species) => species.prototype)) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  prototypes = {
    document: await io.read(path.join(PROTOTYPES_DIR, "prototypes.glb")),
    manifest: JSON.parse(await fs.readFile(path.join(PROTOTYPES_DIR, "prototypes-manifest.json"), "utf8")),
  };
}

const manifest = {
  version: 1,
  // Generated entirely from the project's own procedural geometry and leaf texture —
  // no third-party art. Re-run the bake instead of editing these files.
  source: "procedural (src/foliage, bake-impostors.mjs)",
  variant: args.variant,
  spritesPerSide: args.spritesPerSide,
  tileSize: args.tileSize,
  bakeAlphaCutoff: FOLIAGE_ALPHA_CUTOFF,
  runtimeAlphaCutoff: FOLIAGE_IMPOSTOR_ALPHA_CUTOFF,
  species: {},
};

for (const species of SPECIES) {
  const started = performance.now();
  const bake = bakeImpostorAtlas(
    species.prototype
      ? await prototypeBakeOptions(species, args, prototypes)
      : impostorBakeOptionsFor({
          species,
          variant: args.variant,
          spritesPerSide: args.spritesPerSide,
          tileSize: args.tileSize,
          supersample: args.supersample,
        })
  );
  const albedoName = `${species.id}-albedo.png`;
  const normalName = `${species.id}-normal.png`;
  const albedoPng = await encodePng(bake.albedo);
  const normalPng = await encodePng(bake.normalDepth);
  await fs.writeFile(path.join(args.output, albedoName), albedoPng);
  await fs.writeFile(path.join(args.output, normalName), normalPng);

  const coverage = horizonStats(bake.tileCoverage, args.spritesPerSide);
  manifest.species[species.id] = {
    albedo: albedoName,
    normalDepth: normalName,
    centerY: Number(bake.centerY.toFixed(4)),
    radius: Number(bake.radius.toFixed(4)),
    horizonCoverageMean: Number(coverage.mean.toFixed(4)),
    horizonCoverageMin: Number(coverage.min.toFixed(4)),
  };
  console.log(
    `${species.id}: ${(performance.now() - started).toFixed(0)} ms, ` +
      `albedo ${(albedoPng.length / 1024).toFixed(0)} KB, normal ${(normalPng.length / 1024).toFixed(0)} KB, ` +
      `horizon coverage mean ${coverage.mean.toFixed(3)} min ${coverage.min.toFixed(3)}`
  );
}

await fs.writeFile(path.join(args.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${Object.keys(manifest.species).length} species to ${args.output}`);
