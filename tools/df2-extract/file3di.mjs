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
// numbers): face UVs are texel coordinates in 22.10 (UV_FIXED — measured, see
// its note; a 24.8 guess tiled every texture 4x), sub-object bone offsets are
// model units in 24.8, and model units themselves are 1/256 m (UNITS_PER_METER —
// calibrated against the soldier models and the egypt pyramid footprint,
// docs/06 §8).
//
// No dependencies — Node built-ins only. GLB textures use imageio's encodePng.

import { cstr, encodePng } from "./imageio.mjs";

export const SIG_3DI_V8 = 0x08494433; // "3DI\x08" little-endian (V7 = 0x07... exists, unsupported)

/** Model units per meter — the calibrated 3DI unit scale. */
export const UNITS_PER_METER = 256;

/**
 * Face UVs are int32 **16.16 fixed point, already normalised** — divide by
 * 65536 and use directly. NOT texel coordinates: there is no texture-size
 * division. (NovaHQ NovaResearch, "3DI File Format", v5/v8.)
 *
 * Worth the note because two wrong readings look right for a while: treating
 * them as texel coords in 24.8 (`/256/width`) is numerically IDENTICAL for a
 * 256-wide texture and wrong for every other size — 64-wide tiles 4x too much,
 * 512-wide 2x too little — so the error only shows on some props, and "fixing"
 * it by changing the shift just moves which sizes are wrong.
 */
export const UV_FIXED = 65536;

const SUBOBJ_STRIDES = [112, 256];
const LOD_HEADER = 192;

/**
 * v8 material flags (NovaHQ NovaResearch, "3DI File Format").
 *
 * Stored as a uint32 at material offset 16. The other widely-copied reference
 * declares that field as a single byte followed by padding, which drops every
 * bit above 7 — losing ColorKey, Hidden and AlphaBlend.
 */
export const MAT = {
  TEXTURED: 0x0001,
  DOUBLE_SIDED: 0x0002,
  HIDDEN_AUTO: 0x0008,
  FLAT_LIT: 0x0020,
  SPECIAL_BLEND: 0x0080,
  COLOR_KEY: 0x0200,
  SHADOW_PRIORITY: 0x0400,
  HIDDEN: 0x0800,
  ANIMATED: 0x4000,
  ALPHA_BLEND: 0x8000,
};

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
    // ratio 1 = one palette index per pixel; ratio 2 = index + alpha byte
    // (0x00 transparent, 0xFF opaque). A LARGER ratio is not a stride at all —
    // it is N animation frames sharing one palette, so frame 0 is the still
    // image and its pixels are contiguous, not interleaved.
    const ratio = numPixels > 0 ? bmSize / numPixels : 0;
    const animated = Number.isInteger(ratio) && ratio > 2;
    const stride = animated ? 1 : ratio;
    textures.push({
      name: texName,
      width,
      height,
      stride,
      /** N>1 when the slot holds an animation; only frame 0 is exported. */
      frames: animated ? ratio : 1,
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
      // Offset 0 is the documented face Flags u16 (bit 0 = smooth-shaded, i.e.
      // use per-vertex normals); the C# reference calls it `null0` and drops it.
      // Offset 2 holds small sequential integers — an index, not a bitfield.
      flags: dv.getUint16(f, true),
      surface: dv.getInt16(f + 2, true),
      // 16.16 fixed -> normalised UV (see UV_FIXED). Values outside [0,1) tile.
      tu: [
        dv.getInt32(f + 4, true) / UV_FIXED,
        dv.getInt32(f + 8, true) / UV_FIXED,
        dv.getInt32(f + 12, true) / UV_FIXED,
      ],
      tv: [
        dv.getInt32(f + 16, true) / UV_FIXED,
        dv.getInt32(f + 20, true) / UV_FIXED,
        dv.getInt32(f + 24, true) / UV_FIXED,
      ],
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
      nNormals: dv.getInt32(s + 20, true),
      parentBone: dv.getInt32(s + 36, true),
      // 24.8 fixed -> model units, fraction kept (a >>8 truncated it).
      vecOff: [dv.getInt32(s + 52, true) / 256, dv.getInt32(s + 56, true) / 256, dv.getInt32(s + 60, true) / 256],
    };
  }
  off += c.nSubObjects * soSize;

  off += c.nPartAnims * 12;

  // --- collision: a BSP of convex volumes, each bounded by half-space planes --
  // Planes are 8 bytes: normal in 1.14 fixed (÷16384) plus a distance. Volumes
  // are 80 bytes in v8 and carry an AABB, a splitting plane, two BSP child
  // indices and how many of the plane records they own. Model space, so the
  // same unit as vertices (1/256 m).
  const colPlanes = new Array(c.nColPlanes);
  for (let i = 0; i < c.nColPlanes; i++) {
    const o = off + i * 8;
    colPlanes[i] = {
      n: [
        dv.getInt16(o, true) / 16384,
        dv.getInt16(o + 2, true) / 16384,
        dv.getInt16(o + 4, true) / 16384,
      ],
      d: dv.getInt16(o + 6, true),
    };
  }
  off += c.nColPlanes * 8;

  // Volumes are 80 bytes each — the stride is certain (it is what makes the
  // file measure out to EOF) but the FIELD LAYOUT is not. NovaResearch's
  // v5/v8 struct (Flags, Type, int32[6] bbox, splitting plane, BSP children,
  // PlaneCount) does not describe these bytes: read that way the bounding boxes
  // come out inverted and far outside the mesh, and no 6×int32 run anywhere in
  // the record matches the model's own extent. Left RAW rather than exposing
  // fields that would look authoritative and be wrong.
  const colVolumes = new Array(c.nColVolumes);
  for (let i = 0; i < c.nColVolumes; i++)
    colVolumes[i] = { raw: buf.subarray(off + i * 0x50, off + (i + 1) * 0x50) };
  off += c.nColVolumes * 0x50;

  const materials = new Array(c.nMaterials);
  for (let i = 0; i < c.nMaterials; i++) {
    const m = off + i * 120;
    // Flags are a uint32 at 16 — the C# reference declares a byte plus 3 pad,
    // which silently drops bits 8-15 (ColorKey, Hidden, AlphaBlend).
    materials[i] = {
      name: cstr(buf, m, 16),
      flags: dv.getUint32(m + 16, true),
      texIndex: buf[m + 52],
    };
  }
  off += c.nMaterials * 120;

  return { ...c, bounds, vertices, normals, faces, subObjects, materials, colPlanes, colVolumes };
}

/* --- GLB export --------------------------------------------------------------
 * DF2 models are z-up; glTF is y-up right-handed. The conversion is a -90°
 * ROTATION about X — `(x, y, z) -> (x, z, -y)` — matching how the engine's own
 * tooling moves between the two spaces (opennova `GetWorldPosition`).
 *
 * It must be a rotation, not the reflection `(x, z, y)` this once used. A
 * reflection turns every model into its own mirror image; reversing the
 * triangle winding hides that (faces point outward again, so it renders
 * plausibly) while leaving the geometry handed the wrong way. Symmetric props
 * look fine, which is what let it survive — an asymmetric one just reads as
 * rotated, and no yaw offset can correct it. A rotation preserves winding, so
 * the faces keep their authored order.
 *
 * UVs arrive normalised; wrap sampling (glTF's default) handles the tiling
 * values outside [0,1).
 */
const WINDING = [0, 1, 2];

export function toGlb(model, { lod = 0, scale = 1 } = {}) {
  const L = model.lods[lod];
  if (!L) throw new Error(`no LOD ${lod} (model has ${model.lodCount})`);
  if (L.faces.length === 0)
    throw new Error(`LOD ${lod} of ${model.name} has no faces — nothing to export`);

  // FACE INDICES ARE SUB-OBJECT LOCAL. Vertices, normals and faces are all
  // stored as one array per LOD, but each sub-object's faces index into ITS OWN
  // block — so a turret's face 0 means "the turret's vertex 0", not the model's.
  // Read globally, every multi-part model silently draws its later parts out of
  // the first part's vertices: the T-80 came out as a hull with no turret and no
  // gun, while single-part models (crates, the Khufu pyramid) looked perfect.
  // Walk the sub-objects and record each face's vertex/normal base.
  const faceVertBase = new Int32Array(L.nFaces);
  const faceNormBase = new Int32Array(L.nFaces);
  {
    let v0 = 0;
    let n0 = 0;
    let f0 = 0;
    for (const so of L.subObjects) {
      for (let f = f0; f < f0 + so.nFaces && f < L.nFaces; f++) {
        faceVertBase[f] = v0;
        faceNormBase[f] = n0;
      }
      v0 += so.nVerts;
      n0 += so.nNormals;
      f0 += so.nFaces;
    }
  }

  // Flags bit 0: vertices are bone-relative; world position needs the owning
  // sub-object's VecOff subtracted. Zero-filled when the flag is clear, so the
  // vertex loop below needs no branch. (When the flag is CLEAR the vertices are
  // already in model space — the T-80's turret block sits at z 1.84-3.09 m,
  // matching its 1.86 m bone offset, so adding it again would double it.)
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

  // Group faces by texture AND by the render flags that change the glTF
  // material — two materials can share a texture and differ in whether they are
  // double-sided or unlit, and merging those would pick one at random.
  // HIDDEN (bit 11) is documented as "face skipped" and this exporter briefly
  // honoured it. It is WRONG to drop those faces, at least for v8: doing so
  // punched a 12.2 x 6.9 m hole in `rbuilda`'s interior — a whole room's inner
  // wall band — visible the moment you stand inside one. The materials in
  // question also lack TEXTURED and carry HIDDEN_AUTO ("bound texture
  // missing"), so whatever the bit gates, it is conditional in a way the v8
  // notes do not capture. Kept parsed and unused until something measures it.
  const RENDER_FLAGS = MAT.DOUBLE_SIDED | MAT.FLAT_LIT | MAT.ALPHA_BLEND | MAT.COLOR_KEY;
  const groups = new Map();
  for (let i = 0; i < L.faces.length; i++) {
    const f = L.faces[i];
    const mat = f.material >= 0 && f.material < L.materials.length ? L.materials[f.material] : null;
    // TEXTURED gates the binding: on an untextured material the texIndex byte is
    // stale storage, not a reference. Binding it anyway painted texture 0 across
    // rbuilda's interior wall band where the engine drew flat colour — so an
    // untextured material resolves to -1 (the base-colour fallback), which also
    // keeps it in a separate group from a TEXTURED one sharing the same byte.
    const boundTex = mat && (mat.flags & MAT.TEXTURED) !== 0 ? mat.texIndex : -1;
    const key = `${boundTex}|${mat ? mat.flags & RENDER_FLAGS : 0}`;
    let g = groups.get(key);
    if (!g) {
      groups.set(key, (g = []));
      // Carry the key with the group: `materialFor` dedupes on the SAME key, and
      // rebuilding it there would mean two sites agreeing on both the separator
      // and the mask — disagree and you silently get more glTF materials than
      // primitives, or fewer, with no error.
      g.key = key;
      g.texIndex = boundTex;
      g.flags = mat ? mat.flags : 0;
    }
    g.push({ f, vBase: faceVertBase[i], nBase: faceNormBase[i] });
  }
  if (groups.size === 0)
    throw new Error(`LOD ${lod} of ${model.name}: no renderable faces`);

  const jsonImages = [];
  const jsonTextures = [];
  const jsonMaterials = [];
  const jsonMeshPrimitives = [];
  const buffers = [];
  let unlitUsed = false;
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

  /**
   * Dilate opaque colour into fully-transparent texels ("alpha bleed").
   *
   * Transparent texels in these textures hold the chroma key, and on DF2 assets
   * that key is frequently pure green — `palette[0]` on the EdBro husk is
   * literally (0,255,0). Alpha hides it at full resolution, but every mip level
   * averages RGB across neighbours regardless of alpha, so the green bleeds
   * into the silhouette and blooms as a fringe with distance. Filling the
   * transparent RGB with the nearest real colour makes those averages harmless.
   * Alpha itself is never touched.
   */
  const alphaBleed = (rgba, w, h) => {
    const filled = new Uint8Array(w * h);
    let anyEmpty = false;
    for (let i = 0; i < w * h; i++) {
      filled[i] = rgba[i * 4 + 3] > 0 ? 1 : 0;
      if (!filled[i]) anyEmpty = true;
    }
    // Run until the whole texture is covered, not a fixed few passes: each pass
    // grows the filled region by one texel, and the deepest mip levels average
    // over the WHOLE image — so a green pocket in the middle of a large
    // transparent region still reaches the screen. Bounded by max(w, h), which
    // is when the last texel must have been reached; these are 8-128 px.
    for (let pass = 0; pass < Math.max(w, h) && anyEmpty; pass++) {
      const next = filled.slice();
      // A pass that fills nothing can never be followed by one that does: the
      // frontier only grows from already-filled texels. Without this a texture
      // with NO opaque pixel at all runs every pass doing no work.
      let grew = false;
      anyEmpty = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (filled[i]) continue;
          let r = 0, g = 0, b = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (!filled[j]) continue;
              r += rgba[j * 4]; g += rgba[j * 4 + 1]; b += rgba[j * 4 + 2]; n++;
            }
          }
          if (n) {
            rgba[i * 4] = (r / n) | 0;
            rgba[i * 4 + 1] = (g / n) | 0;
            rgba[i * 4 + 2] = (b / n) | 0;
            next[i] = 1;
            grew = true;
          } else anyEmpty = true;
        }
      }
      filled.set(next);
      if (!grew) break;
    }
  };

  // Palette -> RGBA, done here so only referenced textures pay for it.
  // `colorKey` makes palette index 0 fully transparent (the v8 ColorKey flag).
  const decodeRgba = (tex, colorKey) => {
    if (!tex.width || !tex.height || (tex.stride !== 1 && tex.stride !== 2)) return null;
    const numPixels = tex.width * tex.height;
    const rgba = new Uint8Array(numPixels * 4);
    for (let p = 0; p < numPixels; p++) {
      const index = tex.scanLines[p * tex.stride];
      const idx = index * 4;
      rgba[p * 4 + 0] = tex.palette[idx + 2];
      rgba[p * 4 + 1] = tex.palette[idx + 1];
      rgba[p * 4 + 2] = tex.palette[idx + 0];
      rgba[p * 4 + 3] =
        colorKey && index === 0 ? 0 : tex.stride === 2 ? tex.scanLines[p * tex.stride + 1] : 255;
    }
    alphaBleed(rgba, tex.width, tex.height);
    return rgba;
  };

  const matToGltf = new Map();
  /** One glTF material per (texture, render-flags) pair, keyed by the group's own key. */
  const materialFor = (key, texIndex, flags) => {
    if (matToGltf.has(key)) return matToGltf.get(key);
    const tex = model.textures[texIndex];
    // ColorKey makes palette index 0 transparent even in a 1-byte texture; the
    // 2-byte form carries per-pixel alpha instead.
    const rgba = tex ? decodeRgba(tex, (flags & MAT.COLOR_KEY) !== 0) : null;
    const doubleSided = (flags & MAT.DOUBLE_SIDED) !== 0;
    const cutout = tex && (tex.stride === 2 || flags & MAT.COLOR_KEY);
    const blend = (flags & MAT.ALPHA_BLEND) !== 0;

    const material = rgba
      ? { pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } }
      : {
          pbrMetallicRoughness: {
            baseColorFactor: [0.8, 0.8, 0.8, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        };
    if (rgba) {
      const png = encodePng(tex.width, tex.height, rgba, 4);
      const viewIdx = pushView(png);
      const imgIdx = jsonImages.push({ bufferView: viewIdx, mimeType: "image/png" }) - 1;
      const texIdx = jsonTextures.push({ source: imgIdx, sampler: 0 }) - 1;
      material.pbrMetallicRoughness.baseColorTexture = { index: texIdx };
    }
    if (doubleSided) material.doubleSided = true;
    if (blend) material.alphaMode = "BLEND";
    else if (cutout) {
      material.alphaMode = "MASK";
      material.alphaCutoff = 0.5;
    }
    // FlatLit means the engine skipped lighting for this surface — glTF says
    // that with KHR_materials_unlit rather than a fudged emissive.
    if (flags & MAT.FLAT_LIT) {
      material.extensions = { KHR_materials_unlit: {} };
      unlitUsed = true;
    }
    const matIdx = jsonMaterials.push(material) - 1;
    matToGltf.set(key, matIdx);
    return matIdx;
  };

  for (const faces of groups.values()) {
    const n = faces.length * 3;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let p = 0;
    for (const { f, vBase, nBase } of faces) {
      for (const c of WINDING) {
        const iv = vBase + f.v[c];
        // (x, y, z) -> (x, z, -y): the -90° rotation about X, see WINDING above.
        const x = (L.vertices[iv * 4] - vertOffset[iv * 3]) * scale;
        const y = (L.vertices[iv * 4 + 2] - vertOffset[iv * 3 + 2]) * scale;
        const z = -(L.vertices[iv * 4 + 1] - vertOffset[iv * 3 + 1]) * scale;
        pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
        for (let a = 0; a < 3; a++) {
          const v = pos[p * 3 + a];
          if (v < min[a]) min[a] = v;
          if (v > max[a]) max[a] = v;
        }
        // Face flags bit 0 = smooth-shaded (per-vertex normals). Without it the
        // face is FLAT and wants one geometric normal for all three corners —
        // applying the stored per-vertex normals everywhere rounds off edges
        // that should be hard, which is most of a crate or a wall.
        if (f.flags & 1) {
          const ni = (nBase + f.n[c]) * 4;
          // Same rotation as the position, or lighting disagrees with the surface.
          const nx = L.normals[ni], ny = L.normals[ni + 2], nz = -L.normals[ni + 1];
          const len = Math.hypot(nx, ny, nz) || 1;
          nrm[p * 3] = nx / len; nrm[p * 3 + 1] = ny / len; nrm[p * 3 + 2] = nz / len;
        }
        uv[p * 2] = f.tu[c];
        uv[p * 2 + 1] = f.tv[c];
        p++;
      }
      // Flat face: one geometric normal, computed after all three corners exist.
      if (!(f.flags & 1)) {
        const o = (p - 3) * 3;
        const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
        const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        for (let k = 0; k < 3; k++) {
          nrm[o + k * 3] = nx; nrm[o + k * 3 + 1] = ny; nrm[o + k * 3 + 2] = nz;
        }
      }
    }
    const posAcc = accessors.push({ bufferView: pushView(pos, 34962), componentType: 5126, count: n, type: "VEC3", min, max }) - 1;
    const nrmAcc = accessors.push({ bufferView: pushView(nrm, 34962), componentType: 5126, count: n, type: "VEC3" }) - 1;
    const uvAcc = accessors.push({ bufferView: pushView(uv, 34962), componentType: 5126, count: n, type: "VEC2" }) - 1;
    jsonMeshPrimitives.push({
      attributes: { POSITION: posAcc, NORMAL: nrmAcc, TEXCOORD_0: uvAcc },
      material: materialFor(faces.key, faces.texIndex, faces.flags),
    });
  }

  const gltf = {
    asset: { version: "2.0", generator: "df2-extract file3di" },
    ...(unlitUsed ? { extensionsUsed: ["KHR_materials_unlit"] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: model.name || "model" }],
    meshes: [{ primitives: jsonMeshPrimitives }],
    materials: jsonMaterials,
    textures: jsonTextures,
    images: jsonImages,
    // NEAREST magnification. These textures are 8-64 px across and DF2
    // point-sampled them; bilinear magnification rounds the corners off a
    // window and smears its alpha into a halo — the "blurred edges" look.
    // Mips stay linear between levels so distant props do not shimmer.
    samplers: [{ magFilter: 9728, minFilter: 9986, wrapS: 10497, wrapT: 10497 }],
    bufferViews,
    accessors,
    buffers: [{ byteLength: binLength }],
  };
  // Empty arrays are invalid glTF for these two.
  if (jsonTextures.length === 0) {
    delete gltf.textures;
    delete gltf.images;
    delete gltf.samplers; // an empty samplers array is invalid glTF too
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
  const totalLength = 12 + 8 + jsonBuf.length + 8 + binTotal;
  header.writeUInt32LE(totalLength, 8);
  const jsonHdr = Buffer.alloc(8);
  jsonHdr.writeUInt32LE(jsonBuf.length, 0);
  jsonHdr.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const binHdr = Buffer.alloc(8);
  binHdr.writeUInt32LE(binTotal, 0);
  binHdr.writeUInt32LE(0x004e4942, 4); // "BIN"
  return Buffer.concat(
    [header, jsonHdr, jsonBuf, binHdr, ...buffers, binPad],
    totalLength
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
