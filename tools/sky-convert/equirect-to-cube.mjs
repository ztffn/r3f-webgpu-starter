// Turn an equirectangular sky panorama into the six cube faces this renderer loads.
//
// The sky pipeline is cubemaps — public/assets/sky/<slug>/{px,nx,py,ny,pz,nz}.png —
// because the fog now fades toward the same cube the background draws, and a cube is the
// one form both can sample. Most free sky packs ship 2:1 panoramas instead. This resamples
// one into the other and reports the colours a weather preset needs, so adding a sky is a
// command rather than an eyedropper.
//
// Usage: node tools/sky-convert/equirect-to-cube.mjs <panorama.png> <slug> [faceSize]
//
// ImageMagick decodes the source panorama, because this pipeline's own imageio reads PCX
// and not PNG. Writing goes through that imageio's `encodePng`, which every other output
// in tools/ already uses — six faces is six subprocesses saved, and one place to change
// if the output encoding ever does.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "../df2-extract/imageio.mjs";

/**
 * Each face as an origin and the two image axes, so `dir = forward + u*right + v*up`
 * with u running left to right and v running TOP TO BOTTOM, image order.
 *
 * This is the standard cube-map basis, the one `CubeTextureLoader` expects for names in
 * three's own +X, -X, +Y, -Y, +Z, -Z order. Getting the vertical sense wrong is the
 * failure that matters and is instantly visible; getting the longitude origin wrong only
 * spins the sky on its axis, which for a cloud field is not detectable at all.
 */
const FACES = {
  px: { f: [1, 0, 0], r: [0, 0, -1], u: [0, -1, 0] },
  nx: { f: [-1, 0, 0], r: [0, 0, 1], u: [0, -1, 0] },
  py: { f: [0, 1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  ny: { f: [0, -1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  pz: { f: [0, 0, 1], r: [1, 0, 0], u: [0, -1, 0] },
  nz: { f: [0, 0, -1], r: [-1, 0, 0], u: [0, -1, 0] },
};

const MAX_BUFFER = 1 << 28;

function readRGBA(path) {
  const meta = execFileSync("magick", ["identify", "-format", "%w %h", path]).toString();
  const [width, height] = meta.trim().split(/\s+/).map(Number);
  const data = execFileSync("magick", [path, "-depth", "8", "-colorspace", "sRGB", "RGBA:-"], {
    maxBuffer: MAX_BUFFER,
  });
  return { width, height, data };
}

/**
 * Bilinear sample of the panorama, WRAPPING in longitude and CLAMPING in latitude.
 *
 * The wrap is load-bearing: a face straddling the seam samples both edges of the image,
 * and clamping there draws a vertical crease down one face that no amount of blurring
 * hides. Latitude has no seam to wrap — the poles are the ends of the image.
 */
function sample(src, u, v) {
  const { width, height, data } = src;
  const x = u * width - 0.5;
  const y = v * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.min(height - 1, Math.max(0, Math.floor(y)));
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const xa = ((x0 % width) + width) % width;
  const xb = (xa + 1) % width;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * width + xa) * 4 + c];
    const b = data[(y0 * width + xb) * 4 + c];
    const d = data[(y1 * width + xa) * 4 + c];
    const e = data[(y1 * width + xb) * 4 + c];
    out[c] = (a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy;
  }
  return out;
}

function buildFace(src, basis, size) {
  const out = Buffer.alloc(size * size * 4, 255);
  for (let j = 0; j < size; j++) {
    const v = (2 * (j + 0.5)) / size - 1;
    for (let i = 0; i < size; i++) {
      const u = (2 * (i + 0.5)) / size - 1;
      let dx = basis.f[0] + u * basis.r[0] + v * basis.u[0];
      let dy = basis.f[1] + u * basis.r[1] + v * basis.u[1];
      let dz = basis.f[2] + u * basis.r[2] + v * basis.u[2];
      // Only the elevation needs normalising — `atan2(dz, dx)` is scale-invariant, so
      // the other two divides would be thrown away.
      dy /= Math.hypot(dx, dy, dz);
      // three's own equirect convention, so a pack converted here and a pack loaded as a
      // panorama land the same way up and the same way round.
      const su = Math.atan2(dz, dx) / (2 * Math.PI) + 0.5;
      const sv = 1 - (Math.asin(Math.max(-1, Math.min(1, dy))) / Math.PI + 0.5);
      const rgb = sample(src, su, sv);
      const o = (j * size + i) * 4;
      out[o] = Math.round(rgb[0]);
      out[o + 1] = Math.round(rgb[1]);
      out[o + 2] = Math.round(rgb[2]);
    }
  }
  return out;
}

/** Mean colour of a latitude band, as the hex a preset wants. */
function bandHex(src, fromV, toV) {
  const { width, height, data } = src;
  const y0 = Math.floor(fromV * height);
  const y1 = Math.min(height, Math.ceil(toV * height));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  const hex = (c) =>
    Math.round(c / n)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const [input, slug, sizeArg] = process.argv.slice(2);
if (!input || !slug) {
  console.error("usage: equirect-to-cube.mjs <panorama.png> <slug> [faceSize]");
  process.exit(1);
}
const size = Number(sizeArg) || 512;
const src = readRGBA(input);
const dir = join("public", "assets", "sky", slug);
mkdirSync(dir, { recursive: true });
for (const [name, basis] of Object.entries(FACES)) {
  writeFileSync(join(dir, `${name}.png`), encodePng(size, size, buildFace(src, basis, size), 4));
}
// Printed, not written beside the faces: everything under public/ is served, and the
// place provenance belongs is the preset that cites the pack. The band a preset's
// fogColor has to live in is the one terrain ends against — the horizon, not the sky as a
// whole — so the two are reported separately.
console.log(
  `${slug}: ${size}px faces from ${src.width}x${src.height}` +
    `  horizon ${bandHex(src, 0.45, 0.55)}  upper ${bandHex(src, 0.0, 0.5)}`
);
