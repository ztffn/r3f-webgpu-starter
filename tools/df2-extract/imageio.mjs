// Minimal image codecs and byte helpers for the DF2 asset pipeline — Node
// built-ins only.
//
//   decodePcx()  8-bit RLE PCX (the format NovaLogic heightmaps/detail maps use)
//   decodeTga()  uncompressed truecolor TGA (the detail_color strip / sky palettes)
//   encodePng()  greyscale / RGB PNG via node:zlib
//   cstr()       NUL-terminated string from a fixed-length field
//
// See docs/02-asset-format-specification.md §2/§3/§5.

import zlib from "node:zlib";

/** Read a NUL-terminated string from a fixed-length field. Lives here rather
 * than in a parser so the PFF and 3DI modules share it without importing each
 * other — df2extract already dynamic-imports file3di, and a static import back
 * would close that cycle. */
export function cstr(buf, off, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = buf[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// --- PCX ---------------------------------------------------------------------

/**
 * Decode an 8-bit, single-plane PCX (RLE or uncompressed).
 * @returns {{width:number,height:number,pixels:Uint8Array,palette:Uint8Array|null}}
 *          `pixels` holds raw palette indices (NOT resolved to RGB) — for a
 *          greyscale heightmap the index *is* the elevation value.
 */
export function decodePcx(buf) {
  if (buf[0] !== 0x0a) throw new Error("Not a PCX file (bad manufacturer byte)");
  const encoding = buf[2];
  const bitsPerPixel = buf[3];
  const xmin = buf.readUInt16LE(4);
  const ymin = buf.readUInt16LE(6);
  const xmax = buf.readUInt16LE(8);
  const ymax = buf.readUInt16LE(10);
  const nPlanes = buf[65];
  const bytesPerLine = buf.readUInt16LE(66);

  if (bitsPerPixel !== 8 || nPlanes !== 1)
    throw new Error(`Unsupported PCX: ${bitsPerPixel}bpp, ${nPlanes} planes`);

  const width = xmax - xmin + 1;
  const height = ymax - ymin + 1;
  const total = bytesPerLine * height;
  const scan = new Uint8Array(total);

  let p = 128;
  let o = 0;
  if (encoding === 1) {
    while (o < total && p < buf.length) {
      const b = buf[p++];
      if ((b & 0xc0) === 0xc0) {
        const run = b & 0x3f;
        const v = buf[p++];
        for (let i = 0; i < run && o < total; i++) scan[o++] = v;
      } else {
        scan[o++] = b;
      }
    }
  } else {
    scan.set(buf.subarray(128, 128 + total));
  }

  // bytesPerLine can exceed width (padding) — trim each row.
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    pixels.set(scan.subarray(y * bytesPerLine, y * bytesPerLine + width), y * width);
  }

  // 256-colour VGA palette lives in the last 769 bytes, marked by 0x0C.
  let palette = null;
  const pi = buf.length - 769;
  if (pi > 0 && buf[pi] === 0x0c) palette = Uint8Array.from(buf.subarray(pi + 1, pi + 769));

  return { width, height, pixels, palette };
}

// --- TGA ---------------------------------------------------------------------

/**
 * Decode NovaLogic's TGA usage: uncompressed truecolor (type 2) at 24 or 32 bpp
 * (docs/02 §2). The detail_color `_cm` strip is 32-bit, the `skygrd` palettes are
 * 24-bit. Color-mapped, RLE and greyscale variants don't occur in the corpus and
 * are rejected. Any TGA 2.0 footer past the pixel data is simply never read.
 * @returns {{width:number,height:number,channels:number,pixels:Uint8Array}}
 *          `pixels` is RGB or RGBA, rows top-to-bottom regardless of file origin.
 */
export function decodeTga(buf) {
  const idLength = buf[0];
  const colorMapType = buf[1];
  const imageType = buf[2];
  if (imageType !== 2 || colorMapType !== 0)
    throw new Error(`Unsupported TGA: imageType=${imageType} colorMapType=${colorMapType}`);
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const depth = buf[16];
  const descriptor = buf[17];
  if (depth !== 24 && depth !== 32) throw new Error(`Unsupported TGA depth: ${depth}`);

  const channels = depth / 8;
  const topToBottom = (descriptor & 0x20) !== 0;
  const start = 18 + idLength;
  // Bounds-check before decoding: reading past a Buffer's end yields undefined,
  // which Uint8Array assignment coerces to 0 — a truncated strip would decode
  // "successfully" into black rows and ship as a corrupt committed atlas with
  // nothing in the pipeline ever reporting a problem.
  const needed = start + width * height * channels;
  if (buf.length < needed) {
    throw new Error(
      `Truncated TGA: header says ${width}x${height} at ${depth}bpp ` +
        `(${needed} bytes), file has ${buf.length}`
    );
  }
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const srcRow = topToBottom ? y : height - 1 - y;
    let s = start + srcRow * width * channels;
    let d = y * width * channels;
    for (let x = 0; x < width; x++) {
      // TGA stores BGR(A); emit RGB(A).
      pixels[d] = buf[s + 2];
      pixels[d + 1] = buf[s + 1];
      pixels[d + 2] = buf[s];
      if (channels === 4) pixels[d + 3] = buf[s + 3];
      s += channels;
      d += channels;
    }
  }
  return { width, height, channels, pixels };
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode raw 8-bit samples as PNG. channels: 1 = greyscale, 3 = RGB, 4 = RGBA.
 */
export function encodePng(width, height, data, channels = 1) {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
