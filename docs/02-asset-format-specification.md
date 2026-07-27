# 02 — Asset Format Specification

Structural reference for the NovaLogic file formats used by Delta Force 2. The
authoritative source for the reverse-engineered layouts below is the open-source
[`Acruid/NovalogicTools`](https://github.com/Acruid/NovalogicTools) C# codebase
(`PffArchive.cs`, `TgaConvert.cs`, `PcxConvert.cs`, `File3di.cs`); this document restates
that knowledge in a renderer-agnostic form and flags the fields we still need to confirm
empirically against real TXP/EXP2b data.

> **Confidence key:** ✅ confirmed structurally · 🟡 believed / needs empirical confirmation
> against real terrain files · ⛔ unknown.

---

## 1. PFF archive container (`.pff`) ✅

A flat, uncompressed archive. Two versions are seen in DF-era content: `PFF2` and `PFF3`.
DF2 uses `PFF3`.

### 1.1 Header (20 bytes)

| Offset | Size | Type   | Field            | Notes |
| ------ | ---- | ------ | ---------------- | ----- |
| 0x00   | 4    | u32    | header length    | usually 20 |
| 0x04   | 4    | char[4]| magic            | `"PFF3"` (or `"PFF2"`) |
| 0x08   | 4    | u32    | file count       | number of file records |
| 0x0C   | 4    | u32    | record size      | 32 for PFF3 |
| 0x10   | 4    | u32    | record table offset | absolute offset to first file record |

### 1.2 File record (32 bytes, PFF3)

| Offset | Size | Type    | Field        | Notes |
| ------ | ---- | ------- | ------------ | ----- |
| 0x00   | 4    | u32     | deleted flag | 0 = live entry |
| 0x04   | 4    | u32     | data offset  | absolute offset of file bytes |
| 0x08   | 4    | u32     | data length  | bytes |
| 0x0C   | 4    | u32     | modified time| unix-ish timestamp |
| 0x10   | 16   | char[16]| filename     | null-padded, original 8.3-ish name |

Extraction is therefore: read header → seek to record table → for each of `file count`
records, read the 32-byte entry, then read `data length` bytes at `data offset`. There is
no per-file compression to undo.

### 1.3 TypeScript port note (Phase 0)

The Node CLI (`df2-extract`) mirrors `PffArchive.cs`:

```
readHeader() -> { magic, count, recordSize, tableOffset }
readRecords() -> Record[]           // 32-byte structs
extract(record) -> Uint8Array       // slice of the mmap'd buffer
```

All integers are little-endian. Use a `DataView` over the whole file buffer; do not stream.

---

## 2. Image payloads: TGA and PCX ✅ (format) / 🟡 (which is used where)

Individual assets inside the archive are stored as ordinary **TGA** (truecolor or 8-bit
palettized) and **PCX** (8-bit RLE) images. Both are well-documented public formats:

- **TGA** — the subset NovaLogic emits is uncompressed (type 2, truecolor) and 8-bit
  color-mapped (type 1). `TgaConvert.cs` handles both. Watch the image-descriptor byte
  (origin corner): NovaLogic images are typically stored top-left, so a vertical flip may
  be needed when emitting a bottom-left PNG.
- **PCX** — 8-bit, RLE-compressed, palette in the trailing 768 bytes (256×RGB). This is the
  classic ZSoft PCX. `PcxConvert.cs` handles decode.

The Phase 0 pipeline decodes each to raw RGBA and re-encodes as PNG for the web build.

---

## 3. `.3DI` model format (V8) ✅ structure / 🟡 some sub-tables

NovaLogic's proprietary model container for characters and vehicles. Version **V8** is
confirmed for DF2. Reverse-engineered by `File3di.cs`. High-level structure:

- **File header** — magic + version, counts and offsets for the sub-tables below,
  bounding info.
- **LOD table** — `.3DI` models are multi-LOD; each LOD entry points at its own vertex and
  face lists. (This maps naturally onto glTF LOD extensions or separate meshes.)
- **Vertex list** — positions (fixed-point or float; confirm scale factor per file). 🟡
- **Face list** — indexed polygons with a material/texture index and per-face flags
  (double-sided, transparent, etc.).
- **Texture table** — references into an embedded or sibling texture set (often 8-bit
  palettized, same decode path as §2).
- **Sub-object / bone hierarchy** — used for animated parts (turrets, limbs). 🟡 exact
  animation-track layout still to be validated.

### 3.1 Conversion target

`.3DI` → glTF 2.0. Each LOD becomes a mesh primitive (or a separate node tagged with a
screen-coverage threshold). Palettized textures are expanded to RGBA PNG and referenced as
glTF images. The first conversion milestone is a single static character/vehicle model
rendered in-engine, no animation.

---

## 4. Terrain asset set (per map) 🟡

Each terrain is a small bundle of 2D images plus scalar parameters. Believed contents:

| Asset | Format | Meaning |
| --- | --- | --- |
| **Colormap** | truecolor image | per-texel surface albedo used by the raycaster |
| **Heightmap** | 8-bit greyscale | per-texel elevation (0–255 → world height via a scale) |
| **Detail map** | 8-bit palettized | material/zone index per texel (grass / sand / rock / water). Palette meaning is TBD — see §5 and `01-...md` §7 |
| **Detail color strip** | truecolor strip | small texture atlas of close-up ground detail, tiled under the colormap |
| **Detail elevation strip** | 8-bit greyscale strip | per-material tall-grass / relief height source — the "stretched voxel" height driver |
| **Sky / water / lighting params** | small binary or text | fog color, water level, sun direction, palette selection |

The **detail elevation strip** is the single most important unknown for grass fidelity: it
is believed to encode, per detail-map material index, how tall the "stretched voxels"
extrude. Confirming its exact mapping (§7 of `01-...md`) directly drives the Phase 2 grass
height field.

---

## 5. Terrain packing convention 🟡

Working hypothesis (to confirm against real files): terrain images are **not** a bespoke
binary format — they are plain TGA/PCX images packed into the map's `.pff` alongside a
small params blob, distinguished only by filename convention. If confirmed, Phase 0 needs
no terrain-specific decoder beyond §1–§2; it just classifies extracted images by name.

Empirical confirmation steps once files arrive:

1. Unpack a known EXP2b terrain (e.g. **River**) with `df2-extract`.
2. Enumerate members; classify by extension/name/dimensions.
3. Verify the heightmap is single-channel and the detail map is 8-bit palettized.
4. Cross-check heightmap dimensions against colormap dimensions (expected equal or a fixed
   ratio).

---

## 6. Coordinate & scale conventions (to pin down) 🟡

- **World scale:** meters-per-texel of the heightmap. Comanche-era Voxel Space used square
  maps; DF2 is reported larger/tiled. Until confirmed, the renderer treats world scale as a
  single configurable constant (`METERS_PER_TEXEL`).
- **Height scale:** 8-bit height → world height multiplier. Configurable constant
  (`HEIGHT_SCALE`) until read from the params blob.
- **Axis convention:** heightmap is a top-down image; Three.js uses +Y up, so image (u,v)
  maps to world (x,z) and the sampled height to world y.

The synthetic scaffold in `src/df2/` already exposes these as constants so that swapping in
real data (Phase 4) is a data change, not a code change.
