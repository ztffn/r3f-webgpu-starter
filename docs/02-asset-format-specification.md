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

> **✅ Implemented** as `decodeTga()` in `tools/df2-extract/imageio.mjs` (Aug 2026), validated
> against `DFG5_CM.TGA` (64×16384, 32-bit detail-color strip) and `SKYGRD01.TGA` (16×257,
> 24-bit sky gradient). Uncompressed truecolor only, as specified below; the columnar shader
> still takes ground colour from the colormap (rendering design doc §4.1, AS BUILT) — the
> renderer does not consume `detail_color` yet, and DFG5's railroad shows what that costs
> (`06-...md` §11).

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

> **✅ Implemented** in `tools/df2-extract/imageio.mjs` (8-bit RLE + the appended 256-colour
> VGA palette), validated against real archives. Terrain files **do** use this format: the
> heightmap, detail map and `detail_elev` strip are all PCX (§5).

Standard PCX with an embedded palette (`Colormap`, 48-byte field found via
`[FieldOffset(16)]` in the reference header struct — i.e. a 16-color EGA-style palette
embedded in the header, distinct from PCX's separate 256-color VGA palette appended at
end-of-file for 8-bit PCX variants). Used for some texture/UI assets, and — **confirmed
against real data** — for the terrain heightmap, detail map and `detail_elev` strip (§5).

---

## 4. `.3DI` model format (character/vehicle/object geometry)

> **✅ Implemented and corpus-validated (2026-08-06).** `tools/df2-extract/file3di.mjs`
> parses V8 and exports GLB (`df2extract.mjs 3di <f> [out.glb]`); 642 of the 644 retail
> models parse with exact end-of-buffer alignment (the 2 failures are V7-signature LAMP
> variants). Corrections found against the reference tool are folded into the tables
> below, plus the facts it left open:
>
> - **`HeaderLodInfo` is 36 bytes, not 20** — the C# declared `Size=20` but lays out
>   9×u32; 36 makes the 128-byte header exact and puts `TextureCount` at offset 124.
> - **`ModelSubObject` is 112 bytes** (the C# trailing `int[48]` is really `byte[48]`) —
>   confirmed by EOF alignment across the corpus.
> - **Embedded texture body**: after the 52-byte header come `_bmSize` bytes of indexed
>   pixels (stride `_bmSize/(w*h)`: 1 = opaque, 2 = index+alpha), then a 256×4 **BGRA**
>   palette.
> - **UVs are int32 16.16 fixed point and ALREADY NORMALISED** — `u = tu/65536`, with **no
>   texture-size division**. Values outside [0,1) tile and need wrap sampling.
>   *Trap worth keeping:* reading them as texel coordinates in 24.8 (`tu/256/width`) is
>   numerically IDENTICAL for a 256-wide texture and wrong for every other size — 64-wide
>   tiles 4× too much, 512-wide 2× too little. Both of this project's guesses (24.8, then
>   22.10) reproduced that class of error, each visibly wrong on a different subset of
>   props, until the format spec settled it. Sub-object offsets in the same file ARE 24.8,
>   and normals are 1.14 (÷16384); three different fixed-point conventions in one file.
> - **Face vertex and normal indices are SUB-OBJECT LOCAL** — they index that mesh's own
>   vertex/normal block, not the LOD's global array. Add the running sum of preceding
>   sub-objects' counts. Read globally, a multi-part model silently draws its later parts
>   out of the first part's vertices: the T-80 exported as a hull with no turret and no
>   gun barrel, while single-part models looked perfect.
> - **A pixel ratio above 2 is not a stride** — it is N animation frames sharing one
>   palette (ratio 1 = indexed, ratio 2 = index + alpha byte, 0x00 transparent).
> - **Model forward is +X, up is +Z.** Converting to a y-up target is a −90° **ROTATION**
>   about X — `(x, y, z) → (x, z, −y)` — never the reflection `(x, z, y)`. The reflection
>   mirrors every model; reversing triangle winding makes it *render* plausibly (faces
>   point outward again) while leaving the geometry handed the wrong way, so symmetric
>   props look correct and asymmetric ones read as rotated by an amount no yaw offset can
>   fix. A rotation preserves winding — do not reverse it. Normals take the same rotation.
> - Mission placement in the same space, **measured against DF2 data** (docs runbook,
>   2026-08-07): mission `(x, y)` maps straight to world `(X, Z)`, and
>   **`yaw = facing − 90°`**, pitch negated about X, roll positive about Z, **YXZ** order.
>   Only the pitch/roll/order part comes from opennova's `MissionEntity.GetWorldRotation`;
>   its position mapping (`x,−y`) and yaw (`180 − facing`) are **wrong for DF2** — that
>   code targets Joint Operations, two engine generations later. Do not copy them across
>   without re-measuring.
>
> Source for the four points above: NovaHQ **NovaResearch**,
> `Shared/3DI File Format.md` — the most precise DF-era format documentation found so far.
> - **Units: 256 model units = 1 m.** Standing character models measure 467–470 units
>   (1.83 m); LOD-header bounds are the int16 vertex bounds ×256 (i.e. meters in 16.16).
>   This plus the egypt pyramid footprint calibrated `METERS_PER_TEXEL` (see `06` §9).

Confirmed structure for `FileVersion.V8` (only version this project needs to support,
per the reference tool — other versions throw `NotSupportedException`). Signature
`0x08494433` ("3DI\x08"); the two V7 files (`0x07494433`) are not parsed.

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
6. **ColPlanes** (`nColPlanes` × 8 bytes) — **parsed and verified.** `Nx, Ny, Nz` as
   int16 in **1.14 fixed point (÷16384)** then `D` as int16, in model units (1/256 m).
   All 23,461 planes in the retail corpus have unit-length normals, which confirms the
   fixed-point reading. A stone column has 6 planes, a crate 6 (its planes sit at ±348 and
   ±361 units — exactly its mesh extent), an adobe building 146.
7. **ColVolumes** (`nColVolumes` × 0x50 bytes) — **stride certain, LAYOUT NOT.** 80 bytes
   is what makes the file measure out to EOF, but NovaResearch's v5/v8 struct (Flags,
   Type, `int32[6]` bbox, splitting plane, BSP children, PlaneCount) does not describe
   these bytes: read that way the boxes come out inverted and far outside the model, and
   no 6×int32 run anywhere in the record matches the mesh extent. `file3di.mjs` keeps them
   raw rather than exposing fields that would look authoritative and be wrong.

**Collision architecture:** 388 of 623 models carry collision — 23,461 planes and 3,083
volumes. It is a set of convex volumes bounded by half-space planes (the volume record
holds BSP child indices), *separate from the render mesh* and far coarser: a 475-face
adobe building reduces to 18 volumes over 146 planes. So a shot is tested against
half-spaces, not triangles.

**Surface identity ("what did I just hit") is on the MATERIAL, not the collision volume** —
material flag bits 16-19 and 26-29 encode bullet-impact surface types. Two of the labelled
bits check out against the corpus: bit 19 ("foliage/leaves") appears on the cypress, bit 27
("cloth/flag") on the flags. A wooden crate carries bit 17, a metal wall bits 16+17, a
stone column bit 18. See §4's flag table.
8. **Materials** (`nMaterials` × `ModelMaterial`, 0x78/120 bytes each):

   | Field | Type | Notes |
   |---|---|---|
   | Name | char[16] | offset 0 |
   | **Flags** | **u32 @ 16** | render + surface flags, see below |
   | IndexG/B/W/A | byte each @ 52 | Texture index references; the texture is `IndexG` |

   **Material flags (u32 at offset 16) — NOT a byte.** The widely-copied C# reference
   declares a byte plus three pad bytes, which silently discards every bit above 7 and
   with them `ColorKey`, `Hidden` and `AlphaBlend`. Measured across the 18,115 materials
   in the retail corpus:

   | Bit | Name | Meaning | Share |
   |---|---|---|---|
   | 0 `0x0001` | Textured | samples a texture | 89.6% |
   | 1 `0x0002` | **DoubleSided** | render both faces | **32.8%** |
   | 3 `0x0008` | HiddenAuto | bound texture missing | 1.6% |
   | 5 `0x0020` | FlatLit | skip lighting | 5.8% |
   | 7 `0x0080` | SpecialBlend | special alpha rendering | 1.2% |
   | 9 `0x0200` | ColorKey | palette index 0 is transparent | — |
   | 10 `0x0400` | ShadowPriority | | — |
   | 11 `0x0800` | Hidden | documented "face skipped" — **do NOT act on it**, see below | 1.0% |
   | 14 `0x4000` | Animated | cycle material frames | 6.8% |
   | 15 `0x8000` | AlphaBlend | alpha blend mode | 24.0% |

   Double-siding is per material and lands where you would expect: tent canopies, foliage
   and building interiors carry it; crates and solid masonry do not.

   **`Hidden` (bit 11) must NOT be treated as "drop this face" — measured 2026-08-07.**
   Acting on it punched a 12.2 × 6.9 m hole in `rbuilda`'s interior (28 faces, a whole
   room's inner wall band), obvious the moment you stand inside one. The materials that
   set it also lack `Textured` and set `HiddenAuto` ("bound texture missing"), so whatever
   the bit gates is conditional in a way the v8 notes do not capture. Parse it; ignore it.

   **Sampling:** magnify these textures with NEAREST. They are 8–64 px across and the
   engine point-sampled them; bilinear magnification rounds the corners off window
   openings and smears alpha into a halo. Window glass is genuinely graduated alpha (169
   distinct values on `rbuilda`'s), so `AlphaBlend` really does mean blend, not cutout.

   **Transparent texels hold a CHROMA KEY, and it is often pure green.** `palette[0]` on
   the EdBro husk is literally `(0,255,0)`, and the transparent regions of the desert
   truck's textures average the same. Alpha hides it at full resolution, but mip
   generation averages RGB across neighbours *regardless of alpha*, so the key bleeds into
   the silhouette and blooms as a coloured fringe with distance — misreadable as LOD
   fading. A converter must **alpha-bleed**: dilate real colour outward until every
   transparent texel holds a plausible RGB, leaving alpha untouched. Dilate to full
   coverage, not a few passes: the deepest mip averages the whole image, so a green pocket
   in the middle of a large transparent region still reaches the screen.

   **Bits 13 and 16-28 are set but undocumented for v8.** The v10 page assigns bits 16-19
   and 26-29 to *bullet-impact surface types*, and the v8 corpus uses exactly that region
   (bit 16 on 1576 materials, 17 on 1228, 18 on 889, 26 on 851, …; 43 distinct patterns).
   So DF2 already tags each material with what a round hitting it should do — directly
   useful to the ballistics work, and the model-side counterpart of the terrain's
   `char_data` surface classes.

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
| `char_data` | `<set>_cm.cal` | **Plaintext, 256 lines `<material>,<param>`** — ground character per detail index (line *N* = index *N−1*). Vocabulary seen: `Gs2`/`Gs3` grass, `Dt2` dirt, `Rk2` rock, `Md3` mud, `rd1` railroad, `ct1` concrete, `null`. `param` is 40 on the hard surfaces (`rd1`/`ct1`), 0 otherwise |
| `sky_map` | `clouds<NN>.pcx` | **PCX, 512×512 palettized** cloud layer (the shipped set skips `clouds09`) |
| `sky_palette` | `skygrd<NN>.tga` | **TGA, 16×257, 24-bit** sky gradient LUT |
| `water_map` | `ripple1.pcx` | **PCX, 256×256 palettized** water ripple tile |
| env params | (in `.trn`) | `sky_height`, `horizon`, `water_height`, `filter` RGB, `gamma`, `saturation`, `sun_slope` — plain scalars |

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
