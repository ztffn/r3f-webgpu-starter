#!/usr/bin/env node
// prepare-terrain — turn one extracted DF terrain into web-ready assets.
//
//   node prepare-terrain.mjs <extractedDir> <trnName> <outDir>
//   e.g. node prepare-terrain.mjs assets/exp2b gmile public/assets/terrain/gmile
//
// Reads the .trn manifest, then emits:
//   height.png    greyscale 8-bit elevation (from <elev_map>.pcx)
//   color.jpg     colormap, copied through (already web-native JPEG)
//   detail.png    greyscale detail-map INDICES (from <detail_map>.pcx), if present
//   terrain.json  parsed .trn + dimensions + which referenced assets were missing
//
// Output is intentionally written outside git (see .gitignore) — extracted game
// assets are never committed. See docs/06-asset-extraction-findings.md.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
import { parseTrn } from "./df2extract.mjs";
import { decodePcx, encodePng } from "./imageio.mjs";

const [extractedDir, trnName, outDir] = process.argv.slice(2);
if (!extractedDir || !trnName || !outDir) {
  console.error("usage: prepare-terrain.mjs <extractedDir> <trnName> <outDir>");
  process.exit(1);
}

// Case-insensitive lookup of "<base>.<any ext>" within the extracted directory.
const files = readdirSync(extractedDir);
function find(base, exts) {
  const b = base.toLowerCase();
  for (const f of files) {
    const e = extname(f).toLowerCase();
    if (f.toLowerCase().slice(0, f.length - e.length) === b && (!exts || exts.includes(e)))
      return join(extractedDir, f);
  }
  return null;
}

const trnPath = find(trnName, [".trn"]);
if (!trnPath) throw new Error(`No ${trnName}.trn in ${extractedDir}`);
const trn = parseTrn(readFileSync(trnPath, "latin1"));
mkdirSync(outDir, { recursive: true });

const meta = { source: trnName, trn, assets: {}, missing: [] };
console.log(`Preparing "${trn.terrain_name}" by ${trn.terrain_creator}`);

// --- heightmap (elev_map) ---------------------------------------------------
const elevPath = find(trn.elev_map, [".pcx"]);
if (!elevPath) throw new Error(`heightmap ${trn.elev_map}.pcx not found`);
const elev = decodePcx(readFileSync(elevPath));
let min = 255;
let max = 0;
for (const v of elev.pixels) {
  if (v < min) min = v;
  if (v > max) max = v;
}
writeFileSync(join(outDir, "height.png"), encodePng(elev.width, elev.height, elev.pixels, 1));
meta.assets.height = {
  file: "height.png",
  width: elev.width,
  height: elev.height,
  rawMin: min,
  rawMax: max,
};
console.log(`  height.png  ${elev.width}x${elev.height}  raw range ${min}..${max}`);

// --- colormap (color_map) — JPEG passthrough --------------------------------
const colorPath = find(trn.color_map, [".jpg", ".jpeg"]);
if (colorPath) {
  copyFileSync(colorPath, join(outDir, "color.jpg"));
  meta.assets.color = { file: "color.jpg" };
  console.log(`  color.jpg   copied from ${colorPath.split("/").pop()}`);
} else {
  meta.missing.push(trn.color_map);
  console.log(`  ! colormap ${trn.color_map} missing`);
}

// --- detail map (detail_map) — emit palette INDICES as greyscale -------------
const detailPath = find(trn.detail_map, [".pcx"]);
if (detailPath) {
  const d = decodePcx(readFileSync(detailPath));
  const uniq = new Set(d.pixels).size;
  writeFileSync(join(outDir, "detail.png"), encodePng(d.width, d.height, d.pixels, 1));
  meta.assets.detail = { file: "detail.png", width: d.width, height: d.height, distinctIndices: uniq };
  console.log(`  detail.png  ${d.width}x${d.height}  ${uniq} distinct indices`);
} else {
  meta.missing.push(trn.detail_map);
}

// --- detail elevation strip (grass stretch heights) -------------------------
// Often a shared base-game asset that isn't bundled with a terrain pack; pass
// --detail-elev <file.pcx> to substitute a strip we do have (docs/06 §7).
const elevOverride = process.argv.indexOf("--detail-elev");
const dmPath =
  elevOverride > -1 ? process.argv[elevOverride + 1] : find(trn.detail_elev, [".pcx"]);

if (dmPath) {
  const dm = decodePcx(readFileSync(dmPath));
  const tileW = dm.width;
  const tileCount = Math.floor(dm.height / tileW);
  const substituted = elevOverride > -1;
  writeFileSync(join(outDir, "detail_elev.png"), encodePng(dm.width, dm.height, dm.pixels, 1));
  meta.assets.detailElev = {
    file: "detail_elev.png",
    width: dm.width,
    height: dm.height,
    tileSize: tileW,
    tiles: tileCount,
    substituted,
    substitutedFrom: substituted ? dmPath.split("/").pop() : undefined,
    referencedName: trn.detail_elev,
  };
  console.log(
    `  detail_elev.png ${dm.width}x${dm.height} (${tileCount} tiles of ${tileW}px)` +
      (substituted ? `  [SUBSTITUTED for missing "${trn.detail_elev}"]` : "")
  );

  // --- bake grassHeightField -----------------------------------------------
  // docs/06 §6: detail_map[x,z] -> index -> detail_elev tile -> stretch height.
  // The detail textures tile across the ground, so within a tile we read
  // (x mod tileW, z mod tileW) — this preserves the per-column height variation
  // that gives the canopy its ragged silhouette (docs/07 §1.3).
  if (detailPath) {
    const d = decodePcx(readFileSync(detailPath));
    const grass = new Uint8Array(d.width * d.height);
    const usedIdx = new Set();
    for (let z = 0; z < d.height; z++) {
      const tz = z % tileW;
      for (let x = 0; x < d.width; x++) {
        const idx = d.pixels[z * d.width + x];
        usedIdx.add(idx);
        const tile = idx % tileCount;
        grass[z * d.width + x] = dm.pixels[(tile * tileW + tz) * tileW + (x % tileW)];
      }
    }
    let gMin = 255;
    let gMax = 0;
    let gSum = 0;
    for (const v of grass) {
      if (v < gMin) gMin = v;
      if (v > gMax) gMax = v;
      gSum += v;
    }
    writeFileSync(join(outDir, "grass.png"), encodePng(d.width, d.height, grass, 1));
    meta.assets.grass = {
      file: "grass.png",
      width: d.width,
      height: d.height,
      rawMin: gMin,
      rawMax: gMax,
      rawMean: +(gSum / grass.length).toFixed(1),
      detailIndicesUsed: usedIdx.size,
      substituted,
    };
    console.log(
      `  grass.png   ${d.width}x${d.height}  stretch ${gMin}..${gMax} (mean ${(gSum / grass.length).toFixed(1)})`
    );
  }
} else {
  meta.missing.push(trn.detail_elev);
  console.log(
    `  ! detail_elev "${trn.detail_elev}" not present (base-game asset) — pass --detail-elev <strip.pcx> to substitute`
  );
}

writeFileSync(join(outDir, "terrain.json"), JSON.stringify(meta, null, 2));
console.log(`  terrain.json written -> ${outDir}`);
if (meta.missing.length) console.log(`  missing refs: ${meta.missing.join(", ")}`);
