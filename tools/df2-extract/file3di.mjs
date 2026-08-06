// file3di — NovaLogic .3DI V8 model parser and GLB (glTF 2.0) exporter.
//
// Byte layout learned from docs/02 §4 and, where the doc had gaps, from reading
// Acruid/NovalogicTools File3di.cs (read-don't-copy; this is an independent
// implementation, validated by end-of-buffer alignment across the model corpus).
//
// Two places the C# reference is self-contradictory, resolved empirically here:
//  - HeaderLodInfo declares Size=20 but lays out 9×u32 = 36 bytes. 36 is correct:
//    it makes the 128-byte header exact (4+12+4+36+68+4) with TextureCount at 124.
//  - ModelSubObject declares Size=112 with a trailing int[48] (=192B, i.e. 256
//    total). 112 fits all 642 V8 retail models; the probe below still tries both.
//
// Fixed-point conventions (decoded at parse time so every consumer gets plain
// numbers): face UVs are texel coordinates in 24.8, sub-object bone offsets are
// model units in 24.8, and model units themselves are 1/256 m (UNITS_PER_METER —
// calibrated against the soldier models and the egypt pyramid footprint,
// docs/06 §8).
//
// No dependencies — Node built-ins only. GLB textures use imageio's encodePng.

import { cstr, encodePng } from "./imageio.mjs";

export const SIG_3DI_V8 = 0x08494433; // "3DI\x08" little-endian (V7 = 0x07... exists, unsupported)

/** Model units per meter — the calibrated 3DI unit scale. */
export const UNITS_PER_METER = 256;

const SUBOBJ_STRIDES = [112, 256];
const LOD_HEADER = 192;

/** The eight section counts at their fixed offsets in a 192-byte LOD header. */
function lodCounts(dv, base) {
  return {
    flags: dv.getInt32(base + 16, true),
    nVertices: dv.getInt32(base + 128, true),
    nNormals: dv.getInt32(base + 136, true),
    nFaces: dv.getInt32(base + 144, true),
    nSubObjects: dv.getInt32(base + 152, true),
    nPartAnims: dv.getInt32(base + 160, true),
    nMaterials: dv.getInt32(base + 168, true),
    nColPlanes: dv.getInt32(base + 176, true),
    nColVolumes: dv.getInt32(base + 184, true),
  };
}

/** Parse a .3DI V8 buffer. Throws on signature/geometry that doesn't add up. */
export function parse3di(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = dv.getUint32(0, true);
  if (sig !== SIG_3DI_V8)
    throw new Error(`Not a 3DI V8 file (sig 0x${sig.toString(16)})`);

  const name = cstr(buf, 4, 12);
  const lodCount = dv.getUint32(20, true);
  const lodDists = [24, 28, 32, 36].map((o) => dv.getUint32(o, true));
  const textureCount = dv.getInt32(124, true);
  if (lodCount > 8 || textureCount < 0 || textureCount > 512)
    throw new Error(`Implausible header: lods=${lodCount} textures=${textureCount}`);

  let off = 128;

  // --- embedded textures: 52-byte header, indexed bitmap, 256×4 BGRA palette --
  // Pixels stay as zero-copy subarrays; RGBA expansion happens in toGlb only for
  // the textures a primitive actually references — an info run or corpus scan
  // never pays for it.
  const textures = [];
  for (let i = 0; i < textureCount; i++) {
    if (off + 52 > buf.byteLength) throw new Error(`truncated in texture ${i} header`);
    const texName = cstr(buf, off, 28);
    const bmSize = dv.getInt32(off + 28, true);
    const width = dv.getUint16(off + 36, true);
    const height = dv.getUint16(off + 38, true);
    off += 52;
    if (bmSize < 0 || off + bmSize + 256 * 4 > buf.byteLength)
      throw new Error(`truncated in texture ${texName || i} body`);
    const scanLines = buf.subarray(off, off + bmSize);
    off += bmSize;
    const palette = buf.subarray(off, off + 256 * 4);
    off += 256 * 4;

    const numPixels = width * height;
    // stride 1 = palette index per pixel; 2 = index + alpha byte. Anything else
    // (including zero-area placeholder slots) renders as the grey fallback.
    const stride = numPixels > 0 ? bmSize / numPixels : 0;
    textures.push({
      name: texName,
      width,
      height,
      stride,
      scanLines,
      palette,
    });
  }

  // --- sub-object stride probe -------------------------------------------------
  // The section sizes are pure arithmetic over each LOD header's counts, so the
  // right stride is decided without parsing any geometry: the candidate whose
  // chained sizes land exactly at end-of-buffer wins. (The old approach parsed
  // everything and retried on failure — twice the work and it reported the
  // second candidate's error whatever the real fault was.)
  const measure = (soSize) => {
    const bases = [];
    let o = off;
    for (let i = 0; i < lodCount; i++) {
      if (o + LOD_HEADER > buf.byteLength) return null;
      const c = lodCounts(dv, o);
      for (const n of [c.nVertices, c.nNormals, c.nFaces, c.nSubObjects, c.nMaterials]) {
        if (n < 0 || n > 200000) return null;
      }
      bases.push(o);
      o +=
        LOD_HEADER +
        c.nVertices * 8 +
        c.nNormals * 8 +
        c.nFaces * 72 +
        c.nSubObjects * soSize +
        c.nPartAnims * 12 +
        c.nColPlanes * 8 +
        c.nColVolumes * 0x50 +
        c.nMaterials * 120;
    }
    return o === buf.byteLength ? bases : null;
  };

  let subObjectSize = 0;
  let bases = null;
  for (const s of SUBOBJ_STRIDES) {
    const b = measure(s);
    if (b) {
      subObjectSize = s;
      bases = b;
      break;
    }
  }
  if (!bases)
    throw new Error(`${name}: no sub-object stride fits — truncated or not the documented V8 layout`);

  const lods = bases.map((base) => parseLod(buf, dv, base, subObjectSize));
  return { name, lodCount, lodDists, textureCount, textures, subObjectSize, lods };
}

function parseLod(buf, dv, base, soSize) {
  const c = lodCounts(dv, base);
  const i32 = (o) => dv.getInt32(base + o, true);
  const bounds = {
    xMin: i32(40), xMax: i32(44),
    yMin: i32(48), yMax: i32(52),
    zMin: i32(56), zMax: i32(60),
  };

  let off = base + LOD_HEADER;
  // DataView reads, not an Int16Array view: texture bodies make these offsets
  // odd as often as not (a typed-array view would throw on alignment), and a
  // view over a pooled readFileSync Buffer can read past the file silently.
  const vertices = new Int16Array(c.nVertices * 4);
  for (let i = 0; i < vertices.length; i++) vertices[i] = dv.getInt16(off + i * 2, true);
  off += c.nVertices * 8;
  const normals = new Int16Array(c.nNormals * 4);
  for (let i = 0; i < normals.length; i++) normals[i] = dv.getInt16(off + i * 2, true);
  off += c.nNormals * 8;

  const faces = new Array(c.nFaces);
  for (let i = 0; i < c.nFaces; i++) {
    const f = off + i * 72;
    faces[i] = {
      surface: dv.getInt16(f + 2, true),
      // 24.8 fixed texel coordinates -> plain texel floats.
      tu: [dv.getInt32(f + 4, true) / 256, dv.getInt32(f + 8, true) / 256, dv.getInt32(f + 12, true) / 256],
      tv: [dv.getInt32(f + 16, true) / 256, dv.getInt32(f + 20, true) / 256, dv.getInt32(f + 24, true) / 256],
      v: [dv.getInt16(f + 28, true), dv.getInt16(f + 30, true), dv.getInt16(f + 32, true)],
      n: [dv.getInt16(f + 34, true), dv.getInt16(f + 36, true), dv.getInt16(f + 38, true)],
      material: dv.getInt32(f + 68, true),
    };
  }
  off += c.nFaces * 72;

  const subObjects = new Array(c.nSubObjects);
  for (let i = 0; i < c.nSubObjects; i++) {
    const s = off + i * soSize;
    subObjects[i] = {
      nVerts: dv.getInt32(s + 4, true),
      nFaces: dv.getInt32(s + 12, true),
      parentBone: dv.getInt32(s + 36, true),
      // 24.8 fixed -> model units, fraction kept (a >>8 truncated it).
      vecOff: [dv.getInt32(s + 52, true) / 256, dv.getInt32(s + 56, true) / 256, dv.getInt32(s + 60, true) / 256],
    };
  }
  off += c.nSubObjects * soSize;

  off += c.nPartAnims * 12;
  off += c.nColPlanes * 8;
  off += c.nColVolumes * 0x50;

  const materials = new Array(c.nMaterials);
  for (let i = 0; i < c.nMaterials; i++) {
    const m = off + i * 120;
    materials[i] = { name: cstr(buf, m, 16), texIndex: buf[m + 52] };
  }
  off += c.nMaterials * 120;

  return { ...c, bounds, vertices, normals, faces, subObjects, materials };
}

/* --- GLB export --------------------------------------------------------------
 * DF2 models are z-up; glTF is y-up right-handed. (x,y,z) -> (x,z,y) is a
 * reflection, so triangle winding is reversed to keep faces outward — the
 * stored normals get the same axis swap, which keeps them agreeing with the
 * reversed winding. UVs arrive as texel floats; wrap sampling (glTF's default)
 * handles the tiling values outside [0,1).
 */
const WINDING = [0, 2, 1];

export function toGlb(model, { lod = 0, scale = 1 } = {}) {
  const L = model.lods[lod];
  if (!L) throw new Error(`no LOD ${lod} (model has ${model.lodCount})`);
  if (L.faces.length === 0)
    throw new Error(`LOD ${lod} of ${model.name} has no faces — nothing to export`);

  // Flags bit 0: vertices are bone-relative; world position needs the owning
  // sub-object's VecOff subtracted. Zero-filled when the flag is clear, so the
  // vertex loop below needs no branch.
  const vertOffset = new Float32Array(L.nVertices * 3);
  if (L.flags & 1) {
    let v0 = 0;
    for (const so of L.subObjects) {
      for (let v = v0; v < v0 + so.nVerts && v < L.nVertices; v++) {
        vertOffset[v * 3] = so.vecOff[0];
        vertOffset[v * 3 + 1] = so.vecOff[1];
        vertOffset[v * 3 + 2] = so.vecOff[2];
      }
      v0 += so.nVerts;
    }
  }

  // Group faces by material texture so each glTF primitive is one texture.
  const groups = new Map();
  for (const f of L.faces) {
    const key =
      f.material >= 0 && f.material < L.materials.length ? L.materials[f.material].texIndex : -1;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(f);
  }

  const jsonImages = [];
  const jsonTextures = [];
  const jsonMaterials = [];
  const jsonMeshPrimitives = [];
  const buffers = [];
  let binLength = 0;
  const bufferViews = [];
  const accessors = [];

  const pushView = (bytes, target) => {
    if (binLength % 4 !== 0) {
      const pad = 4 - (binLength % 4);
      buffers.push(Buffer.alloc(pad));
      binLength += pad;
    }
    const view = { buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength };
    if (target) view.target = target;
    bufferViews.push(view);
    buffers.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    binLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  // Palette -> RGBA, done here so only referenced textures pay for it.
  const decodeRgba = (tex) => {
    if (!tex.width || !tex.height || (tex.stride !== 1 && tex.stride !== 2)) return null;
    const numPixels = tex.width * tex.height;
    const rgba = new Uint8Array(numPixels * 4);
    for (let p = 0; p < numPixels; p++) {
      const idx = tex.scanLines[p * tex.stride] * 4;
      rgba[p * 4 + 0] = tex.palette[idx + 2];
      rgba[p * 4 + 1] = tex.palette[idx + 1];
      rgba[p * 4 + 2] = tex.palette[idx + 0];
      rgba[p * 4 + 3] = tex.stride === 2 ? tex.scanLines[p * tex.stride + 1] : 255;
    }
    return rgba;
  };

  const texToGltf = new Map();
  const materialFor = (texIndex) => {
    if (texToGltf.has(texIndex)) return texToGltf.get(texIndex);
    let matIdx;
    const tex = model.textures[texIndex];
    const rgba = tex ? decodeRgba(tex) : null;
    if (!rgba) {
      matIdx =
        jsonMaterials.push({
          pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 },
        }) - 1;
    } else {
      const png = encodePng(tex.width, tex.height, rgba, 4);
      const viewIdx = pushView(png);
      const imgIdx = jsonImages.push({ bufferView: viewIdx, mimeType: "image/png" }) - 1;
      const texIdx = jsonTextures.push({ source: imgIdx }) - 1;
      matIdx =
        jsonMaterials.push({
          pbrMetallicRoughness: { baseColorTexture: { index: texIdx }, metallicFactor: 0, roughnessFactor: 1 },
          ...(tex.stride === 2 ? { alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true } : {}),
        }) - 1;
    }
    texToGltf.set(texIndex, matIdx);
    return matIdx;
  };

  for (const [texIndex, faces] of groups) {
    const tex = model.textures[texIndex];
    const uScale = tex && tex.width ? 1 / tex.width : 0;
    const vScale = tex && tex.height ? 1 / tex.height : 0;
    const n = faces.length * 3;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let p = 0;
    for (const f of faces) {
      for (const c of WINDING) {
        const iv = f.v[c];
        const x = (L.vertices[iv * 4] - vertOffset[iv * 3]) * scale;
        const y = (L.vertices[iv * 4 + 2] - vertOffset[iv * 3 + 2]) * scale; // z-up -> y-up
        const z = (L.vertices[iv * 4 + 1] - vertOffset[iv * 3 + 1]) * scale;
        pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
        for (let a = 0; a < 3; a++) {
          const v = pos[p * 3 + a];
          if (v < min[a]) min[a] = v;
          if (v > max[a]) max[a] = v;
        }
        const ni = f.n[c] * 4;
        const nx = L.normals[ni], ny = L.normals[ni + 2], nz = L.normals[ni + 1];
        const len = Math.hypot(nx, ny, nz) || 1;
        nrm[p * 3] = nx / len; nrm[p * 3 + 1] = ny / len; nrm[p * 3 + 2] = nz / len;
        uv[p * 2] = f.tu[c] * uScale;
        uv[p * 2 + 1] = f.tv[c] * vScale;
        p++;
      }
    }
    const posAcc = accessors.push({ bufferView: pushView(pos, 34962), componentType: 5126, count: n, type: "VEC3", min, max }) - 1;
    const nrmAcc = accessors.push({ bufferView: pushView(nrm, 34962), componentType: 5126, count: n, type: "VEC3" }) - 1;
    const uvAcc = accessors.push({ bufferView: pushView(uv, 34962), componentType: 5126, count: n, type: "VEC2" }) - 1;
    jsonMeshPrimitives.push({
      attributes: { POSITION: posAcc, NORMAL: nrmAcc, TEXCOORD_0: uvAcc },
      material: materialFor(texIndex),
    });
  }

  const gltf = {
    asset: { version: "2.0", generator: "df2-extract file3di" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: model.name || "model" }],
    meshes: [{ primitives: jsonMeshPrimitives }],
    materials: jsonMaterials,
    textures: jsonTextures,
    images: jsonImages,
    bufferViews,
    accessors,
    buffers: [{ byteLength: binLength }],
  };
  // Empty arrays are invalid glTF for these two.
  if (jsonTextures.length === 0) {
    delete gltf.textures;
    delete gltf.images;
  }

  // GLB container, assembled in ONE concat — the payload is megabytes of PNG,
  // and concatenating it repeatedly tripled peak memory.
  let jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const binPad = binLength % 4 ? Buffer.alloc(4 - (binLength % 4)) : Buffer.alloc(0);
  const binTotal = binLength + binPad.length;

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binTotal, 8);
  const jsonHdr = Buffer.alloc(8);
  jsonHdr.writeUInt32LE(jsonBuf.length, 0);
  jsonHdr.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const binHdr = Buffer.alloc(8);
  binHdr.writeUInt32LE(binTotal, 0);
  binHdr.writeUInt32LE(0x004e4942, 4); // "BIN"
  return Buffer.concat(
    [header, jsonHdr, jsonBuf, binHdr, ...buffers, binPad],
    12 + 8 + jsonBuf.length + 8 + binTotal
  );
}

/** One-line-per-LOD summary used by the CLI and the corpus scan. */
export function describe3di(model) {
  const lines = [
    `${model.name}  lods=${model.lodCount} dists=[${model.lodDists.join(",")}] ` +
      `textures=${model.textureCount} subObjSize=${model.subObjectSize}`,
  ];
  for (let i = 0; i < model.lods.length; i++) {
    const L = model.lods[i];
    const b = L.bounds;
    lines.push(
      `  lod${i}: v=${L.nVertices} f=${L.nFaces} sub=${L.nSubObjects} mat=${L.nMaterials} ` +
        `flags=${L.flags} bounds x[${b.xMin},${b.xMax}] y[${b.yMin},${b.yMax}] z[${b.zMin},${b.zMax}]`
    );
  }
  for (const t of model.textures)
    lines.push(`  tex: ${t.name} ${t.width}x${t.height}${t.stride === 2 ? " +alpha" : ""}`);
  return lines.join("\n");
}
