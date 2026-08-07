// Minimal PNG codec for the impostor atlases — exact texels, both directions.
//
// Hand-rolled for one reason: the browser's own decode paths are not faithful. Decoding
// through createImageBitmap/canvas premultiplies alpha, which zeroes the RGB of every
// fully transparent texel — reintroducing at mip level 0 the dark-fringe defect
// alphaMips.ts exists to prevent — and may apply colour management on top. This decoder
// returns the bytes the baker wrote, bit for bit. Runs in both Node and the browser:
// compression rides the CompressionStream/DecompressionStream globals, no node:zlib.
//
// Scope is deliberately narrow: 8-bit RGBA or RGB (returned expanded to RGBA), no
// interlace. The encoder emits filter 0 scanlines; the decoder handles all five standard
// filters so an externally re-optimised asset (oxipng and friends) still loads, and RGB
// support exists because the authored tree-pack trunk textures ship without alpha.

import type { MipLevel } from "./alphaMips.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function transformBytes(
  bytes: Uint8Array,
  stream: { readable: ReadableStream; writable: WritableStream }
): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const response = new Response(blob.stream().pipeThrough(stream as ReadableWritablePair));
  return new Uint8Array(await response.arrayBuffer());
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/** Encode 8-bit RGBA to a PNG. Row 0 of the image becomes the PNG's top scanline. */
export async function encodePng(image: MipLevel): Promise<Uint8Array> {
  const { data, width, height } = image;
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // compression 0, filter 0, interlace 0 — already zeroed.

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = await transformBytes(raw, new CompressionStream("deflate"));

  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a PNG: 8-bit RGB or RGBA, no interlace, any scanline filter. Returns RGBA. */
export async function decodePng(bytes: Uint8Array): Promise<MipLevel> {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idatParts: Uint8Array[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = bytes[offset + 16];
      const colourType = bytes[offset + 17];
      const interlace = bytes[offset + 20];
      if (bitDepth !== 8 || (colourType !== 6 && colourType !== 2) || interlace !== 0) {
        throw new Error(`unsupported PNG layout: depth ${bitDepth} colour ${colourType} interlace ${interlace}`);
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idatParts.push(payload);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  if (width === 0 || height === 0) throw new Error("PNG missing IHDR");

  const compressedLength = idatParts.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let cursor = 0;
  for (const part of idatParts) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const raw = await transformBytes(compressed, new DecompressionStream("deflate"));

  // Unfilter at the FILE's bytes-per-pixel — the "left" neighbour is one source pixel
  // back, so unfiltering RGB data with a hardcoded 4 would corrupt every scanline.
  const stride = width * channels;
  const filtered = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prev = out - stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? filtered[out + x - channels] : 0;
      const up = y > 0 ? filtered[prev + x] : 0;
      const upLeft = y > 0 && x >= channels ? filtered[prev + x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      filtered[out + x] = value & 0xff;
    }
  }
  if (channels === 4) return { data: filtered, width, height };

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = filtered[i * 3];
    data[i * 4 + 1] = filtered[i * 3 + 1];
    data[i * 4 + 2] = filtered[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}
