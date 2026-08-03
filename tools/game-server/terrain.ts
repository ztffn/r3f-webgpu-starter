// Node-side terrain loading for the authoritative game server.
//
// Reads the SAME prepared assets the browser client fetches
// (public/assets/terrain/<slug>/) and builds the Heightfield through the same
// fromHeightmap call, so smoothing, scale and the wrap convention come from the
// one shared implementation — duplicating that math is the divergence hazard
// Heightfield.ts warns about. The only Node-specific code is the PNG decode:
// the repo's own encoder (tools/df2-extract/imageio.mjs) writes 8-bit
// greyscale, non-interlaced, filter-0 rows, and anything else throws loudly
// rather than silently decoding a regenerated asset wrong.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { Heightfield } from "../../src/df2/Heightfield.ts";
import { HEIGHT_SCALE, METERS_PER_TEXEL } from "../../src/df2/config.ts";
import type { TerrainMeta } from "../../src/df2/loadTerrain.ts";

export function loadServerTerrain(
  slug: string,
  assetRoot = "public/assets/terrain"
): Heightfield {
  const base = join(assetRoot, slug);
  const manifest = JSON.parse(
    readFileSync(join(base, "terrain.json"), "utf8")
  ) as TerrainMeta;
  const heightAsset = manifest.assets?.height;
  if (heightAsset === undefined) {
    throw new Error(`${slug}: terrain.json carries no assets.height`);
  }
  const png = decodeGreyPng(readFileSync(join(base, heightAsset.file)));
  if (png.width !== heightAsset.width || png.height !== heightAsset.height) {
    throw new Error(
      `${slug}: ${heightAsset.file} is ${png.width}x${png.height}, ` +
        `manifest says ${heightAsset.width}x${heightAsset.height}`
    );
  }
  if (png.width !== png.height) {
    throw new Error(`${slug}: heightmap must be square, got ${png.width}x${png.height}`);
  }
  return Heightfield.fromHeightmap({
    data: png.pixels,
    size: png.width,
    metersPerTexel: METERS_PER_TEXEL,
    heightScale: HEIGHT_SCALE,
  });
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function decodeGreyPng(file: Buffer): {
  pixels: Uint8Array;
  width: number;
  height: number;
} {
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (file[index] !== PNG_SIGNATURE[index]) throw new Error("not a PNG file");
  }
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  let at = 8;
  while (at + 8 <= file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colourType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || colourType !== 0 || interlace !== 0) {
        throw new Error(
          `unsupported PNG shape (bit depth ${bitDepth}, colour type ${colourType}, ` +
            `interlace ${interlace}); the prepare pipeline writes 8-bit greyscale`
        );
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (width === 0 || idat.length === 0) throw new Error("PNG has no IHDR or no IDAT");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width + 1;
  if (raw.length < stride * height) {
    throw new Error("PNG pixel data is shorter than its declared dimensions");
  }
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride];
    if (filter !== 0) {
      throw new Error(
        `PNG row ${y} uses filter ${filter}; only filter 0 is supported ` +
          `(tools/df2-extract/imageio.mjs writes filter-0 rows)`
      );
    }
    pixels.set(raw.subarray(y * stride + 1, y * stride + 1 + width), y * width);
  }
  return { pixels, width, height };
}
