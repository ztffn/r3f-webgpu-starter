#!/usr/bin/env node

/**
 * Offline hemi-octahedral impostor bake for the far foliage ring.
 *
 * Renders each species' LOD 0 card geometry from a grid of views into albedo and
 * normal+depth atlases (src/foliage/impostorBake.ts does the actual rasterising) and
 * writes KTX2 atlases plus a manifest into public/assets/vegetation/impostors/ (see
 * ktx2.mjs for the format and its audit). Deterministic:
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
  FOLIAGE_BARK_COLOR,
  FOLIAGE_IMPOSTOR_ALPHA_CUTOFF,
} from "../../src/foliage/foliageConfig.ts";
import {
  bakeImpostorAtlas,
  srgbToLinear,
  weightedNormalMips,
} from "../../src/foliage/impostorBake.ts";
import { decodePng } from "../../src/foliage/impostorPng.ts";
import { alphaCoverage, buildCoveragePreservingMips } from "../../src/foliage/alphaMips.ts";
import { encodeKtx2, ktx2Alpha } from "./ktx2.mjs";
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

/**
 * Mean and min coverage over the atlas's HORIZON tiles — the edge of the view grid.
 *
 * Deduplicated by tile INDEX, not by value. The four corners appear twice in this
 * traversal and have to be dropped once, but two distinct horizon tiles can legitimately
 * share a coverage number, and dropping the second silently reweights the mean toward
 * whichever tiles happen to be unique. Measured on the shipped bake, value-dedupe kept 28
 * of bush's 44 horizon tiles and overstated its mean by 0.020. `impostor-bake.test.ts`
 * already dedupes by index; this is the tool agreeing with the test.
 */
function horizonStats(tileCoverage, n) {
  const indices = new Set();
  for (let k = 0; k < n; k += 1) {
    for (const index of [k, (n - 1) * n + k, k * n, k * n + (n - 1)]) indices.add(index);
  }
  const values = [];
  for (const index of indices) {
    const coverage = tileCoverage[index];
    if (Number.isFinite(coverage)) values.push(coverage);
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
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < leafTexture.data.length; i += 4) {
    const a = leafTexture.data[i + 3];
    r += srgbToLinear(leafTexture.data[i]) * a;
    g += srgbToLinear(leafTexture.data[i + 1]) * a;
    b += srgbToLinear(leafTexture.data[i + 2]) * a;
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
    barkColor: FOLIAGE_BARK_COLOR,
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
  version: 2,
  // UASTC + Zstd, mips supplied by the bake. See tools/vegetation/ktx2.mjs.
  format: "ktx2-uastc",
  // Per species, because the two art paths have different provenance and the atlas is a
  // DERIVED work of whichever fed it: the card species are the project's own procedural
  // geometry, the prototype species are the CC-BY pack the prototypes manifest attributes.
  // A blanket "no third-party art" here was wrong for four of the seven. Re-run the bake
  // instead of editing these files.
  source: "src/foliage procedural geometry; prototype species derived from the CC-BY pack in prototypes-manifest.json",
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
  const albedoName = `${species.id}-albedo.ktx2`;
  const normalName = `${species.id}-normal.ktx2`;
  // The mip chain is solved HERE and shipped inside the KTX2, so the runtime derives
  // nothing: the coverage solve is bake-time work and the browser only decodes.
  const albedoLevels = buildCoveragePreservingMips(bake.albedo, FOLIAGE_ALPHA_CUTOFF);
  // Weighted by the albedo chain's alpha, NOT the coverage solver: scaling alpha on a
  // normal atlas would rescale the depth channel, and an unweighted average lets the
  // empty margin's fill normals dominate deep levels and brighten the whole ring.
  const normalLevels = weightedNormalMips(bake.normalDepth, albedoLevels);
  const albedoBytes = await encodeKtx2(path.join(args.output, albedoName), albedoLevels);
  const normalBytes = await encodeKtx2(path.join(args.output, normalName), normalLevels);

  // Audit the TRANSCODED albedo, not the source. Block compression is lossy on alpha and
  // alpha is the silhouette, so the only meaningful question is what the shipped file
  // conceals — measured against the cutoff the far material actually tests at.
  const shipped = await ktx2Alpha(
    path.join(args.output, albedoName),
    bake.albedo.width,
    bake.albedo.height
  );
  const sourceCoverage = alphaCoverage(bake.albedo.data, FOLIAGE_IMPOSTOR_ALPHA_CUTOFF);
  const shippedCoverage = alphaCoverage(shipped.data, FOLIAGE_IMPOSTOR_ALPHA_CUTOFF);
  const coverageDrift = shippedCoverage - sourceCoverage;
  if (coverageDrift < -0.005) {
    throw new Error(
      `${species.id}: encoding thinned the silhouette — coverage ` +
        `${sourceCoverage.toFixed(4)} -> ${shippedCoverage.toFixed(4)}. ` +
        `Concealing less than the source is the fairness-violating direction (docs/08 §8 inv. 6).`
    );
  }

  const coverage = horizonStats(bake.tileCoverage, args.spritesPerSide);
  manifest.species[species.id] = {
    albedo: albedoName,
    normalDepth: normalName,
    shippedCoverageDrift: Number(coverageDrift.toFixed(5)),
    centerY: Number(bake.centerY.toFixed(4)),
    radius: Number(bake.radius.toFixed(4)),
    horizonCoverageMean: Number(coverage.mean.toFixed(4)),
    horizonCoverageMin: Number(coverage.min.toFixed(4)),
  };
  console.log(
    `${species.id}: ${(performance.now() - started).toFixed(0)} ms, ` +
      `albedo ${(albedoBytes / 1024).toFixed(0)} KB, normal ${(normalBytes / 1024).toFixed(0)} KB, ` +
      `horizon coverage mean ${coverage.mean.toFixed(3)} min ${coverage.min.toFixed(3)}, ` +
      `shipped drift ${coverageDrift >= 0 ? "+" : ""}${coverageDrift.toFixed(5)}`
  );
}

await fs.writeFile(path.join(args.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${Object.keys(manifest.species).length} species to ${args.output}`);
