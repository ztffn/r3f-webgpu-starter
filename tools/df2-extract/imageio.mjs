// Minimal image codecs for the DF2 asset pipeline — Node built-ins only.
//
//   decodePcx()  8-bit RLE PCX (the format NovaLogic heightmaps/detail maps use)
//   encodePng()  greyscale / RGB PNG via node:zlib
//
// See docs/02-asset-format-specification.md §3/§5.

import zlib from "node:zlib";

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
