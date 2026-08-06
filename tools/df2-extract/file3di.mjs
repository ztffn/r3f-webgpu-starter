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
//    total). parse3di() tries 112 first and falls back, and reports which fit.
//
// No dependencies — Node built-ins only. GLB textures use imageio's encodePng.

import { encodePng } from "./imageio.mjs";

export const SIG_3DI_V8 = 0x08494433; // "3DI\x08" little-endian

function cstr(buf, off, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = buf[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Parse a .3DI V8 buffer. Throws on signature/geometry that doesn't add up. */
export function parse3di(buf, { subObjectSize } = {}) {
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
  const textures = [];
  for (let i = 0; i < textureCount; i++) {
    const texName = cstr(buf, off, 28);
    const bmSize = dv.getInt32(off + 28, true);
    const width = dv.getUint16(off + 36, true);
    const height = dv.getUint16(off + 38, true);
    off += 52;
    const scanLines = buf.subarray(off, off + bmSize);
    off += bmSize;
    const palette = buf.subarray(off, off + 256 * 4);
    off += 256 * 4;

    const numPixels = width * height;
    const stride = numPixels > 0 ? bmSize / numPixels : 0;
    if (stride !== 1 && stride !== 2)
      throw new Error(`texture ${texName}: stride ${stride} (bmSize=${bmSize}, ${width}x${height})`);
    const rgba = new Uint8Array(numPixels * 4);
    for (let p = 0; p < numPixels; p++) {
      const idx = scanLines[p * stride] * 4;
      rgba[p * 4 + 0] = palette[idx + 2];
      rgba[p * 4 + 1] = palette[idx + 1];
      rgba[p * 4 + 2] = palette[idx + 0];
      rgba[p * 4 + 3] = stride === 2 ? scanLines[p * stride + 1] : 255;
    }
    textures.push({ name: texName, width, height, hasAlpha: stride === 2, rgba });
  }

  // --- LODs ------------------------------------------------------------------
  // Sub-object stride is ambiguous in the reference (see file header); when the
  // caller doesn't pin it, try 112 then 256 and keep whichever lands parsing
  // exactly at end-of-buffer.
  const candidates = subObjectSize ? [subObjectSize] : [112, 256];
  let lastErr = null;
  for (const soSize of candidates) {
    try {
      const lods = [];
      let o = off;
      for (let i = 0; i < lodCount; i++) {
        const lod = parseLod(buf, dv, o, soSize);
        lods.push(lod);
        o = lod.endOffset;
      }
      if (o !== buf.byteLength)
        throw new Error(`parse ended at ${o}, file is ${buf.byteLength}`);
      return { name, lodCount, lodDists, textureCount, textures, subObjectSize: soSize, lods };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${name}: no sub-object stride fits: ${lastErr.message}`);
}

function parseLod(buf, dv, base, soSize) {
  const i32 = (o) => dv.getInt32(base + o, true);
  const flags = i32(16);
  const bounds = {
    xMin: i32(40), xMax: i32(44),
    yMin: i32(48), yMax: i32(52),
    zMin: i32(56), zMax: i32(60),
  };
  const nVertices = i32(128);
  const nNormals = i32(136);
  const nFaces = i32(144);
  const nSubObjects = i32(152);
  const nPartAnims = i32(160);
  const nMaterials = i32(168);
  const nColPlanes = i32(176);
  const nColVolumes = i32(184);
  for (const [label, n] of [["verts", nVertices], ["normals", nNormals], ["faces", nFaces], ["subobjects", nSubObjects], ["materials", nMaterials]]) {
    if (n < 0 || n > 200000) throw new Error(`implausible ${label} count ${n}`);
  }

  let off = base + 192;
  const vertices = new Int16Array(buf.buffer, buf.byteOffset + off, nVertices * 4).slice();
  off += nVertices * 8;
  const normals = new Int16Array(buf.buffer, buf.byteOffset + off, nNormals * 4).slice();
  off += nNormals * 8;

  const faces = new Array(nFaces);
  for (let i = 0; i < nFaces; i++) {
    const f = off + i * 72;
    faces[i] = {
      surface: dv.getInt16(f + 2, true),
      tu: [dv.getInt32(f + 4, true), dv.getInt32(f + 8, true), dv.getInt32(f + 12, true)],
      tv: [dv.getInt32(f + 16, true), dv.getInt32(f + 20, true), dv.getInt32(f + 24, true)],
      v: [dv.getInt16(f + 28, true), dv.getInt16(f + 30, true), dv.getInt16(f + 32, true)],
      n: [dv.getInt16(f + 34, true), dv.getInt16(f + 36, true), dv.getInt16(f + 38, true)],
      material: dv.getInt32(f + 68, true),
    };
  }
  off += nFaces * 72;

  const subObjects = new Array(nSubObjects);
  for (let i = 0; i < nSubObjects; i++) {
    const s = off + i * soSize;
    subObjects[i] = {
      nVerts: dv.getInt32(s + 4, true),
      nFaces: dv.getInt32(s + 12, true),
      parentBone: dv.getInt32(s + 36, true),
      vecOff: [dv.getInt32(s + 52, true), dv.getInt32(s + 56, true), dv.getInt32(s + 60, true)],
    };
  }
  off += nSubObjects * soSize;

  off += nPartAnims * 12;
  off += nColPlanes * 8;
  off += nColVolumes * 0x50;

  const materials = new Array(nMaterials);
  for (let i = 0; i < nMaterials; i++) {
    const m = off + i * 120;
    materials[i] = { name: cstr(buf, m, 16), texIndex: buf[m + 52] };
  }
  off += nMaterials * 120;

  return {
    flags, bounds, nVertices, nNormals, nFaces, nSubObjects, nPartAnims,
    nMaterials, nColPlanes, nColVolumes, vertices, normals, faces, subObjects,
    materials, endOffset: off,
  };
}

/* --- GLB export --------------------------------------------------------------
 * DF2 models are z-up; glTF is y-up right-handed. (x,y,z) -> (x,z,y) is a
 * reflection, so triangle winding is reversed to keep faces outward.
 * UVs: tu/tv are texel coordinates in 24.8 fixed point (verified against
 * texture dimensions on the retail corpus) -> u = tu/256/width.
 */
export function toGlb(model, { lod = 0, scale = 1 } = {}) {
  const L = model.lods[lod];
  if (!L) throw new Error(`no LOD ${lod} (model has ${model.lodCount})`);

  // Flags bit 0: vertices are bone-relative; world position needs the owning
  // sub-object's VecOff (24.8 fixed) subtracted. Vertex ranges are cumulative
  // in sub-object order.
  let vertOffset = null;
  if (L.flags & 1) {
    vertOffset = new Int32Array(L.nVertices * 3);
    let v0 = 0;
    for (const so of L.subObjects) {
      for (let v = v0; v < v0 + so.nVerts && v < L.nVertices; v++) {
        vertOffset[v * 3] = so.vecOff[0] >> 8;
        vertOffset[v * 3 + 1] = so.vecOff[1] >> 8;
        vertOffset[v * 3 + 2] = so.vecOff[2] >> 8;
      }
      v0 += so.nVerts;
    }
  }

  // Group faces by material texture so each glTF primitive is one texture.
  const groups = new Map();
  for (const f of L.faces) {
    const key = f.material >= 0 && f.material < L.materials.length ? L.materials[f.material].texIndex : -1;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
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
    const aligned = binLength % 4 === 0 ? binLength : binLength + (4 - (binLength % 4));
    if (aligned !== binLength) {
      buffers.push(Buffer.alloc(aligned - binLength));
      binLength = aligned;
    }
    const view = { buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength };
    if (target) view.target = target;
    bufferViews.push(view);
    buffers.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    binLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  const texToGltf = new Map();
  const materialFor = (texIndex) => {
    if (texToGltf.has(texIndex)) return texToGltf.get(texIndex);
    let matIdx;
    const tex = model.textures[texIndex];
    if (!tex) {
      matIdx = jsonMaterials.push({ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 } }) - 1;
    } else {
      const png = encodePng(tex.width, tex.height, tex.rgba, 4);
      const viewIdx = pushView(png);
      const imgIdx = jsonImages.push({ bufferView: viewIdx, mimeType: "image/png" }) - 1;
      const texIdx = jsonTextures.push({ source: imgIdx }) - 1;
      matIdx =
        jsonMaterials.push({
          pbrMetallicRoughness: { baseColorTexture: { index: texIdx }, metallicFactor: 0, roughnessFactor: 1 },
          ...(tex.hasAlpha ? { alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true } : {}),
        }) - 1;
    }
    texToGltf.set(texIndex, matIdx);
    return matIdx;
  };

  for (const [texIndex, faces] of groups) {
    const n = faces.length * 3;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let p = 0;
    for (const f of faces) {
      // reversed winding: corners 0,2,1
      for (const c of [0, 2, 1]) {
        const vi = f.v[c] * 4;
        const ox = vertOffset ? vertOffset[f.v[c] * 3] : 0;
        const oy = vertOffset ? vertOffset[f.v[c] * 3 + 1] : 0;
        const oz = vertOffset ? vertOffset[f.v[c] * 3 + 2] : 0;
        const x = (L.vertices[vi] - ox) * scale;
        const y = (L.vertices[vi + 2] - oz) * scale; // z-up -> y-up
        const z = (L.vertices[vi + 1] - oy) * scale;
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
        const tex = model.textures[texIndex];
        uv[p * 2] = tex ? f.tu[c] / 256 / tex.width : 0;
        uv[p * 2 + 1] = tex ? f.tv[c] / 256 / tex.height : 0;
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
    samplers: [],
    bufferViews,
    accessors,
    buffers: [{ byteLength: binLength }],
  };
  if (jsonTextures.length === 0) {
    delete gltf.textures;
    delete gltf.images;
  }
  delete gltf.samplers;

  // GLB container: 12-byte header, JSON chunk (4-pad with spaces), BIN chunk.
  let jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  let bin = Buffer.concat(buffers);
  if (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jsonHdr = Buffer.alloc(8);
  jsonHdr.writeUInt32LE(jsonBuf.length, 0);
  jsonHdr.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const binHdr = Buffer.alloc(8);
  binHdr.writeUInt32LE(bin.length, 0);
  binHdr.writeUInt32LE(0x004e4942, 4); // "BIN"
  return Buffer.concat([header, jsonHdr, jsonBuf, binHdr, bin]);
}

/** One-line-per-LOD summary used by the CLI and the corpus scan. */
export function describe3di(model) {
  const lines = [`${model.name}  lods=${model.lodCount} textures=${model.textureCount} subObjSize=${model.subObjectSize}`];
  for (let i = 0; i < model.lods.length; i++) {
    const L = model.lods[i];
    const b = L.bounds;
    lines.push(
      `  lod${i}: v=${L.nVertices} f=${L.nFaces} sub=${L.nSubObjects} mat=${L.nMaterials} ` +
        `flags=${L.flags} bounds x[${b.xMin},${b.xMax}] y[${b.yMin},${b.yMax}] z[${b.zMin},${b.zMax}]`
    );
  }
  for (const t of model.textures)
    lines.push(`  tex: ${t.name} ${t.width}x${t.height}${t.hasAlpha ? " +alpha" : ""}`);
  return lines.join("\n");
}
