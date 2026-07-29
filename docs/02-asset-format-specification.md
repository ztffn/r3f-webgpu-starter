# Asset Format Specification

Source of truth for all structures below: `Acruid/NovalogicTools` (GitHub, MIT-adjacent,
DF2-specific mod tools, C#), cross-referenced against community documentation from NovaHQ's
terrain-authoring guide. All structures confirmed by reading source directly, not inferred.

---

## 1. PFF3 / PFF2 archive container

> **Verified byte-exact** against real DF-era `.pff` archives (July 2026) — see
> `06-asset-extraction-findings.md`. The parser lives in `tools/df2-extract`.

The `.pff` file is a flat archive: a file-table (directory) plus raw file blobs. Two
signature variants share an identical layout (`PFF2`, `PFF3`).

### 1.1 Header (20 bytes, at file offset 0)

| Field         | Type   | Notes                                   |
|---------------|--------|------------------------------------------|
| HeaderSize    | u32    | Always 20 for supported variants          |
| Signature     | u32    | Magic: `'PFF3'` = 0x33464650, `'PFF2'` = 0x32464650 |
| RecordCount   | u32    | Number of file-table entries              |
| RecordSize    | u32    | Bytes per entry (32 for supported variant)|
| RecordOffset  | u32    | Byte offset to start of file-table        |

### 1.2 File-table entry (32 bytes each, repeated `RecordCount` times starting at `RecordOffset`)

| Field         | Type        | Notes                              |
|---------------|-------------|--------------------------------------|
| Deleted       | u32         | Nonzero = tombstoned entry           |
| FileOffset    | u32         | Byte offset of file contents in archive |
| FileSize      | u32         | Byte length of file contents         |
| FileModified  | u32         | Packed timestamp                     |
| FileName      | byte[15]    | Null-padded ASCII                    |
| Null          | byte[1]     | Padding to 32-byte alignment         |

### 1.3 Extraction algorithm

1. Read header, verify signature/headerSize/recordSize against supported values.
2. Seek to `RecordOffset`, read `RecordCount` × 32-byte entries.
3. For each non-deleted entry, seek to `FileOffset`, read `FileSize` bytes.
4. Write to `FileName` (as extracted from the archive's own basename), preserving
   `FileModified` if desired.

Trivially portable to a ~40-line Node.js `DataView`/`Buffer` reader — no native
dependencies required.

---

## 2. TGA loader

Handles NovaLogic's TGA usage specifically: uncompressed truecolor images at 24-bit or
32-bit pixel depth (`ImageType == UNCOMP_TRUECOLOR`). Does not need to handle
color-mapped, RLE-compressed, or grayscale TGA variants for this project's known data
(those code paths exist in the reference but throw `NotImplementedException`, meaning DF2
assets don't exercise them, or do so rarely enough that the original author didn't hit it).

Standard TGA layout applies:
- 18-byte header (id length, color-map type, image type, color-map spec, image spec:
  x-origin/y-origin/width/height/pixel-depth/descriptor)
- Optional image ID field (`IdLength` bytes)
- Optional color map
- Raw scanline data, bottom-to-top by TGA convention (reference implementation applies a
  180° flip on load to correct this)
- Optional 26-byte footer (new-format TGA signature)

Output: standard RGB/RGBA bitmap, directly convertible to PNG.

---

## 3. PCX loader

Standard PCX with an embedded palette (`Colormap`, 48-byte field found via
`[FieldOffset(16)]` in the reference header struct — i.e. a 16-color EGA-style palette
embedded in the header, distinct from PCX's separate 256-color VGA palette appended at
end-of-file for 8-bit PCX variants). Used for some texture/UI assets; terrain files may or
may not use this format (see §5).

---

## 4. `.3DI` model format (character/vehicle/object geometry)

Confirmed structure for `FileVersion.V8` (only version this project needs to support,
per the reference tool — other versions throw `NotSupportedException`).

### 4.1 Top-level file layout

```
[u32 Signature/Version]
[Header — 128 bytes]
[TextureCount × ModelTexture]
[LodInfo.Count × ModelLod]
```

### 4.2 Header (128 bytes)

| Field         | Type       | Notes                                    |
|---------------|------------|--------------------------------------------|
| Signature     | u32        | `FileVersion`, must equal V8                |
| Name          | char[12]   | Null-terminated/padded model name           |
| (gap)         | u32        | Unused                                      |
| LodInfo       | struct(20B)| See §4.3                                    |
| (gap)         | byte[68]   | Unused (17×4 bytes)                         |
| TextureCount  | i32        | Number of embedded textures                 |

### 4.3 `HeaderLodInfo` (20 bytes)

| Field       | Type | Notes                                  |
|-------------|------|------------------------------------------|
| Count       | u32  | Number of LOD levels present             |
| DistHigh    | u32  | Distance threshold, highest LOD          |
| DistMedium  | u32  | Distance threshold, medium LOD           |
| DistLow     | u32  | Distance threshold, low LOD              |
| DistTiny    | u32  | Distance threshold, lowest/tiny LOD      |
| RendHigh/Medium/Low/Tiny | enum (per LOD) | Render-type flag per LOD level |

### 4.4 `ModelTexHeader` (52 bytes) — per embedded texture

| Field        | Type       | Notes                          |
|--------------|------------|-----------------------------------|
| Name         | char[28]   | Null-terminated texture name      |
| _bmSize      | i32        | Bitmap data size                  |
| Index        | u16        | Texture index                     |
| _flags       | u16        | Unknown flags                     |
| _bmWidth     | u16        | Width                             |
| _bmHeight    | u16        | Height                            |
| PTR_BMLines  | u32        | In-memory pointer (ignore on disk)|
| PTR_Palette  | u32        | In-memory pointer (ignore on disk)|
| PTR_PaletteEnd | u32      | In-memory pointer (ignore on disk)|

### 4.5 Per-LOD block (`ModelLod`) — repeated `LodInfo.Count` times

**`ModelLodHeader`** (192 bytes) — leads each LOD block, gives counts for everything that
follows: `nVertices`, `nNormals`, `nFaces`, `nSubObjects`, `nPartAnims`, `nMaterials`,
`nColPlanes`, `nColVolumes`, plus bounding data (`xMin/xMax/yMin/yMax/zMin/zMax`,
`SphereRadius`, `CircleRadius`) and a `Flags` field (bit 0 indicates bone-relative vertex
offsetting is in effect — relevant for rigged models).

Immediately following the header, in order:

1. **Vertices** (`nVertices` × 8 bytes) — `int16 x, y, z, w` each.
2. **Normals** (`nNormals` × 8 bytes) — `int16 x, y, z, w` each.
3. **Faces** (`nFaces` × `ModelFace`, 72 bytes each):

   | Field | Type | Notes |
   |---|---|---|
   | SurfaceIndex | i16 | |
   | tu1, tu2, tu3 | i32 each | Baked UV U-coords per triangle vertex |
   | tv1, tv2, tv3 | i32 each | Baked UV V-coords per triangle vertex |
   | Vertex1/2/3 | i16 each | Indices into the vertex array |
   | Normal1/2/3 | i16 each | Indices into the normal array |
   | Distance, xMin/xMax/yMin/yMax/zMin/zMax | i32 each | Per-face bounds (culling data) |
   | MaterialIndex | i32 | Index into the material array |

4. **SubObjects** (`nSubObjects` × `ModelSubObject`, 112 bytes each) — hierarchical
   parts/bones: vertex/face/normal/collision-volume counts + pointers (ignore pointers on
   disk), `parentBone` index, and bone offset vectors (`VecXoff/Yoff/Zoff`,
   `diffXoff/Yoff/Zoff`) used to reposition sub-object vertices relative to their parent
   bone at load time.
5. **PartAnims** (`nPartAnims` × 12 bytes) — currently treated as opaque/unparsed in the
   reference implementation (read-and-discard). Needs further reversal if per-part
   animation is required.
6. **ColPlanes** (`nColPlanes` × 8 bytes) — collision planes, currently skipped
   (`reader.BaseStream.Position += 0x08 * nColPlanes` in reference).
7. **ColVolumes** (`nColVolumes` × 0x50 bytes) — collision volumes, currently skipped
   (`+= 0x50 * nColVolumes` in reference).
8. **Materials** (`nMaterials` × `ModelMaterial`, 0x78/120 bytes each):

   | Field | Type | Notes |
   |---|---|---|
   | Name | char[16] | |
   | BitFlags | byte | |
   | IndexG/B/W/A | byte each | Texture index references; `TexIndex` property returns `IndexG` |

### 4.6 Conversion target

Vertices/normals/faces/materials/sub-object hierarchy above is sufficient to emit a
complete textured, riggable OBJ or glTF: vertex positions (scale int16 by whatever unit
factor the extracted terrain scale implies), per-face vertex/normal indices, per-face UV
from the baked `tu/tv` integers (needs a divisor — determine empirically from a known
texture's dimensions, likely UV stored in fixed-point), and material → texture-index
mapping from `ModelMaterial.TexIndex` into the `ModelTexture` list.

---

## 5. Terrain files — CONFIRMED against real data

> The hypothesis below was **verified** by extracting real DF-era terrains (July 2026). Full
> notes, inventory, and the grass data model in `06-asset-extraction-findings.md`; this is a
> summary. As predicted, there is **no proprietary terrain container** — just plain
> JPEG/PCX/TGA images plus a plaintext `.trn` manifest inside the `.pff`.

Each terrain is defined by a small **plaintext `.trn` manifest** that references its images
by base name. Confirmed keys: `terrain_name`, `terrain_creator`, `color_map`, `elev_map`,
`detail_map`, `detail_color`, `detail_elev`, `char_data`, `sky_map`, `sky_palette`,
`sky_height`, `horizon`, `water_map`, `water_height`, `filter` (RGB), `gamma`, `saturation`,
`sun_slope`. Naming convention: `_c` colormap, `_d` elevation, `_m` detail map, `_dm`
detail-elevation strip, `_cm` detail-color strip.

| Role (`.trn` key) | File | **Confirmed** format & size |
|---|---|---|
| `color_map` | `<t>_c.jpg` | **JPEG**, 1024×1024 RGB (pre-shaded; baked lighting/shadow) |
| `elev_map` (heightmap) | `<t>_d.pcx` | **PCX, 1024×1024, 8-bit greyscale** — the heightmap |
| `detail_map` | `<t>_m.pcx` | **PCX, 1024×1024, 8-bit palettized** — per-texel detail index (high-frequency; e.g. 62 distinct indices on Green Mile) |
| `detail_color` | `<set>_cm.tga` | **64×16384 RGBA strip = 256 tiles of 64×64** — ground textures per detail index |
| `detail_elev` | `<set>_dm.pcx` | **64×16384 greyscale strip = 256 tiles of 64×64** — per-index grass **stretch height** |
| env params | (in `.trn`) | `sky_height`, `horizon`, `water_map`, `water_height`, `filter` RGB, `gamma`, `saturation`, `sun_slope` — plain scalars |

**Corrections to the original guess:** colormap is **JPEG** (not TGA); the heightmap is the
`_d.pcx` (`_d` = elevation — the `_m.pcx` is the *detail* map, not the heightmap); the
detail-color/detail-elevation "strips" are concretely **256 stacked 64×64 tiles**, indexed
by the detail-map value.

**Grass model:** `detail_map[x,z]` → index → `detail_elev` tile → stretch height. Baking that
over the whole map yields the `grassHeightField` shared by the renderer (`03-...md` §4.1) and
concealment (`04-...md`). Detail-map palettes are **authored per-terrain**, not fixed.

> ⚠️ **Indices are per grass SET, not per terrain — do not substitute a strip.** A terrain's
> `detail_map` indices only mean anything against the strip its `.trn` names. Feeding a
> different set's `_dm` strip makes index 37 select *that* set's tile 37, so grass comes out
> tall where the map should be bare and bare where it should be chest-high — plausible
> looking and wrong, which is the worst failure mode for a project whose success metric is
> grass. `loadTerrain.ts` therefore refuses a bake tagged `substituted` and falls back to a
> labelled colormap-derived stand-in (`08-...md` §5.3). Green Mile is affected: it references
> the base-game set `dfdg1_dm`, which is in no archive we have (`06-...md` §7).

**Still open:** the greyscale→world-height scale for both heightmap and stretch strip (tune
visually / calibrate), and the contents of the base-game grass set `dfdg1_dm` (not present in
the modding packs — see `06-...md` §7).
