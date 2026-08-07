#!/usr/bin/env node
// prepare-terrain — turn one extracted DF terrain into web-ready assets.
//
//   node prepare-terrain.mjs <extractedDir> <trnName> <outDir>
//   e.g. node prepare-terrain.mjs assets/exp2b gmile public/assets/terrain/gmile
//
// Reads the .trn manifest, then emits:
//   height.png       greyscale 8-bit elevation (from <elev_map>.pcx)
//   color.jpg        colormap, copied through (already web-native JPEG)
//   detail.png       greyscale detail-map INDICES (from <detail_map>.pcx), if present
//   detail_color.png the <detail_color>.tga strip repacked as a square RGB atlas
//                    (16x16 grid of 64px tiles), if present — WebGPU caps texture
//                    dimensions well below the strip's native 16384
//   terrain.json     parsed .trn + dimensions + which referenced assets were missing
//
// Output goes to public/assets/terrain/<slug>/ and IS committed, alongside the raw
// inputs in /assets/ — see README § Asset policy and docs/01 §3. What stays out is
// retail-extracted data. See docs/06-asset-extraction-findings.md for the formats.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
import { parseTrn } from "./df2extract.mjs";
import { decodePcx, decodeTga, encodePng } from "./imageio.mjs";

const [extractedDir, trnName, outDir] = process.argv.slice(2);
if (!extractedDir || !trnName || !outDir) {
  console.error("usage: prepare-terrain.mjs <extractedDir> <trnName> <outDir>");
  process.exit(1);
}

// Case-insensitive lookup of "<base>.<any ext>" within the extracted directory.
// Tolerates a missing base name: several .trn keys are optional, and the callers
// below already handle "not found" by recording it in `missing` — but this used to
// throw an unhelpful TypeError on `undefined.toLowerCase()` before reaching them.
const files = readdirSync(extractedDir);
function find(base, exts) {
  if (typeof base !== "string" || !base) return null;
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
// Decoded ONCE here and reused by the grass bake below. It used to be decoded a
// second time down there, repeating a full RLE pass and a 1 MB allocation.
const detailPath = find(trn.detail_map, [".pcx"]);
const detail = detailPath ? decodePcx(readFileSync(detailPath)) : null;
if (detail) {
  const d = detail;
  const uniq = new Set(d.pixels).size;
  writeFileSync(join(outDir, "detail.png"), encodePng(d.width, d.height, d.pixels, 1));
  meta.assets.detail = { file: "detail.png", width: d.width, height: d.height, distinctIndices: uniq };
  console.log(`  detail.png  ${d.width}x${d.height}  ${uniq} distinct indices`);
} else {
  meta.missing.push(trn.detail_map);
}

// --- detail color strip -> square atlas --------------------------------------
// The close-range ground color in the original comes from this strip, NOT the
// colormap (docs/06 §11: DFG5's railroad exists only here). The 64×16384 strip
// exceeds WebGPU's default texture cap, so repack the 256 tiles into a 16×16
// grid; the material reconstructs tile (i%16, i/16) from the detail index.
const cmPath = find(trn.detail_color, [".tga"]);
if (cmPath) {
  const cm = decodeTga(readFileSync(cmPath));
  const tileW = cm.width;
  const tiles = Math.floor(cm.height / tileW);
  const grid = Math.ceil(Math.sqrt(tiles));
  const atlasSize = grid * tileW;
  const atlas = new Uint8Array(atlasSize * atlasSize * 3);
  for (let t = 0; t < tiles; t++) {
    const gx = (t % grid) * tileW;
    const gy = Math.floor(t / grid) * tileW;
    for (let y = 0; y < tileW; y++) {
      for (let x = 0; x < tileW; x++) {
        const s = ((t * tileW + y) * tileW + x) * cm.channels;
        const d = ((gy + y) * atlasSize + gx + x) * 3;
        atlas[d] = cm.pixels[s];
        atlas[d + 1] = cm.pixels[s + 1];
        atlas[d + 2] = cm.pixels[s + 2];
      }
    }
  }
  writeFileSync(join(outDir, "detail_color.png"), encodePng(atlasSize, atlasSize, atlas, 3));
  meta.assets.detailColor = { file: "detail_color.png", tileSize: tileW, tiles, grid, atlasSize };
  console.log(`  detail_color.png ${atlasSize}x${atlasSize} atlas (${tiles} tiles of ${tileW}px, ${grid}x${grid})`);
} else {
  meta.missing.push(trn.detail_color);
  console.log(`  ! detail_color "${trn.detail_color}" not present — close-range ground detail unavailable`);
}

// --- char_data: per-tile ground character (.cal) ------------------------------
// Plaintext, one "<material>,<param>" line per detail index (docs/02 §5). The
// material family is what separates VEGETATION from RELIEF: detail_elev is a
// general extrusion map (docs/06 §11.1 — rails carry 40, dirt ruts 4-14, grass
// 22-46), so only vegetation families may bake into the canopy field, or every
// stone and rut becomes centimetre "grass" — and grass is concealment, so this
// is a gameplay rule, not a cosmetic one. Vegetation = Gs*/Grs* across all 18
// retail sets; Sw* (swamp) is UNCONFIRMED and deliberately excluded until the
// retail game settles it (plan 2026-08-06 §5). A non-zero param independently
// marks HARD ground (railroad, concrete).
const VEGETATION = /^(gs|grs)/i;
const calPath = find(trn.char_data, [".cal"]);
let vegTiles = null;
if (calPath) {
  // The format is ONE LINE PER DETAIL INDEX, so the line's raw position IS the
  // tile index. Filtering blank lines before indexing (as this once did) shifts
  // every material after a stray blank line by one — vegetation classified as
  // rock gets its canopy zeroed, silently, and grass is concealment. Only the
  // trailing newline's empty tail is trimmed; an interior blank keeps its index
  // and is reported rather than squeezed out.
  const lines = readFileSync(calPath, "latin1").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  vegTiles = new Set();
  const hardTiles = [];
  const materials = [];
  lines.forEach((l, i) => {
    if (l.trim() === "") {
      console.log(`  ! char_data line ${i + 1} is blank — tile ${i} gets no material`);
      return;
    }
    const [name, param] = l.split(",");
    const mat = name.trim();
    materials.push(mat);
    if (VEGETATION.test(mat)) vegTiles.add(i);
    if (Number(param) > 0) hardTiles.push(i);
  });
  meta.assets.charData = {
    entries: lines.length,
    materials: [...new Set(materials)],
    vegetationTiles: vegTiles.size,
    hardTiles,
  };
  console.log(
    `  char_data   ${lines.length} entries, ${vegTiles.size} vegetation tiles ` +
      `(canopy source), hard tiles: ${hardTiles.join(",") || "none"}`
  );
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
  if (detail) {
    const d = detail;
    const grass = new Uint8Array(d.width * d.height);
    const usedIdx = new Set();
    let outOfRange = 0;
    for (let z = 0; z < d.height; z++) {
      const tz = z % tileW;
      for (let x = 0; x < d.width; x++) {
        const idx = d.pixels[z * d.width + x];
        usedIdx.add(idx);
        // A canonical strip carries 256 tiles, so index maps 1:1. A SUBSTITUTED
        // strip may carry fewer, and the wrap silently aliases onto the wrong
        // tile — worth counting rather than hiding, since it is exactly what
        // makes a substituted canopy meaningless (docs/06 §7).
        if (idx >= tileCount) outOfRange++;
        const tile = idx % tileCount;
        // Canopy comes from VEGETATION tiles only (see the char_data note above);
        // relief on dirt/rock/rails stays out of the concealment field. Without a
        // .cal (the community sets ship none) every tile contributes, as before.
        grass[z * d.width + x] =
          vegTiles && !vegTiles.has(idx)
            ? 0
            : dm.pixels[(tile * tileW + tz) * tileW + (x % tileW)];
      }
    }
    if (outOfRange) {
      console.log(
        `  ! ${outOfRange} texels referenced a tile index >= ${tileCount} and wrapped`
      );
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
      /** True when a .cal restricted the canopy to vegetation families. */
      vegetationGated: !!vegTiles,
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
