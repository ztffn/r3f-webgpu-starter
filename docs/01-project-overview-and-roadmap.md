# Delta Force 2 Web Port — Project Overview & Roadmap

## 1. Goal

A browser-based reconstruction of Delta Force 2 (NovaLogic, 1999), targeting fidelity to
the original's two defining technical/design traits:

1. **Terrain and grass system** — NovaLogic's Voxel Space 32 engine, specifically its
   "stretched voxel" tall-grass feature, which allowed a prone player to be effectively
   invisible in grass at up to ~800m while remaining fully traversable terrain.
2. **Asset fidelity** — where legally and technically possible, use real DF2-era terrain
   and model data (colormap/heightmap/detail-map triples, `.3DI` character/vehicle models)
   rather than recreated-from-scratch art.

This is a hobby/personal reconstruction project, not a commercial release.

## 2. Non-goals (for v1)

- Multiplayer / networking
- Full campaign/mission-editor parity
- Exact byte-for-byte engine emulation of Voxel Space's original raycasting rasterizer as
  the primary renderer (it is retained only as an optional "authentic mode" toggle — see
  `03-terrain-and-grass-rendering-design.md`)

## 3. Legal / asset-sourcing posture

- **Preferred asset source:** TXP terrain pack and TerraNova's EXP2b expansion pack for
  DF2. These are freeware, community-authored, explicitly built for redistribution —
  cleaner footing than retail assets, and by most contemporary accounts higher-quality
  terrain/grass authoring than the 1999 stock content. Confirmed named EXP2b tall-grass
  terrains: **Balnakiel, Look, Mile, River**.
- **Fallback asset source:** retail DF2 (currently ~$5 on Steam / Instant Gaming). Extracting
  assets from a purchased copy for personal, non-distributed use is reasonable; **do not**
  redistribute extracted retail assets or ship them in any public build.
- Any future public/shared release of this project must either strip original NovaLogic
  assets or replace them with originals/licensed-alternatives.

## 4. Confirmed technical foundation

- DF2 runs NovaLogic's **Voxel Space 32** engine — a heightfield + colormap raycaster, not
  true volumetric voxels. "Stretched voxels" were a DF2-specific engine feature added
  specifically to simulate tall grass capable of concealing a character at any distance.
- Terrain data per map is a small set of flat 2D image files packed into `.pff` archives,
  indexed by a plaintext `.trn` manifest: colormap (JPEG 1024²), heightmap (PCX 1024²
  8-bit greyscale), detail map (PCX 1024² palettized, grass/sand/rock zoning), a detail
  color strip and a detail elevation strip (each 64×16384 = 256 tiles of 64×64), plus
  ancillary sky/water/lighting scalars. **All of this is now confirmed against real
  extracted data** — see `06-asset-extraction-findings.md`; byte-level spec in
  `02-asset-format-specification.md`.
- Character/vehicle geometry is stored in NovaLogic's proprietary `.3DI` format (version
  V8 confirmed), fully reverse-engineered structurally (see spec doc) via the open-source
  `Acruid/NovalogicTools` repository (MIT-adjacent, GitHub).
- Archive container is `PFF3`/`PFF2`, fully understood (20-byte header, 32-byte file
  records).

## 5. Chosen tech stack (summary — full detail in `05-engine-architecture-tech-stack.md`)

- **Three.js**, using `WebGPURenderer` (production-ready since r171) as primary backend,
  with Three.js's automatic silent fallback to WebGL2 for the ~5% of browsers without
  WebGPU support.
- **TSL (Three Shading Language)** for all custom shaders — single JS-authored shader
  graph compiles to both WGSL (WebGPU) and GLSL (WebGL2), avoiding a dual codebase.
- Node.js/TypeScript asset extraction pipeline (PFF3 unpack → TGA/PCX → PNG, `.3DI` →
  glTF/OBJ), built independent of the game engine, run offline as a build step.

## 6. Phased roadmap

> **Roadmap rewritten July 2026** after real terrain data was successfully extracted from
> two community modding installers (`06-asset-extraction-findings.md`). This removed the
> Phase 0 blocker and reordered priorities: **getting a real, recognizable DF-era map
> running in the browser is now the immediate milestone**, because visual/spatial "feel"
> against a map we actually played is the fastest way to validate the whole approach.

### Phase 0 — Asset pipeline (⬛ largely unblocked; core done)
- ✅ `.pff` (PFF3/PFF2) unpack + `.trn` manifest parse — implemented and validated in
  `tools/df2-extract`.
- ✅ Terrain naming/format convention confirmed empirically (`02-...md` §5).
- ⬜ **Next:** PCX (8-bit RLE) and TGA decoders + JPEG passthrough → PNG, so the runtime
  consumes web-ready images.
- ⬜ **Next:** bake `grassHeightField` = `detail_map` index → `detail_elev` tile height
  (the shared field for grass rendering *and* concealment).
- ⬜ Later: `.3DI` → glTF for a first character/vehicle model (not on the terrain path).

### Phase 1 — Terrain renderer (✅ scaffolded on synthetic data)
- ✅ Chunked/LOD heightmap mesh, skirts, analytic normals, TSL biome material.
- ⬜ Optional literal Voxel Space raycast "authentic mode" as a fragment-shader toggle.

### ▶ Phase 1.5 — **Real-map demo (NEXT MILESTONE)**
Swap synthetic fBm for a real extracted terrain end-to-end. Deliberately pulled *ahead* of
grass, because it is cheap (the renderer already exists), needs no missing base-game assets,
and immediately answers "does this feel like DF2?".
- Decode one terrain's `_d.pcx` heightmap → height source for the existing chunked mesh.
- Drape its `_c.jpg` colormap as the surface texture (replacing the procedural biome blend).
- Calibrate the two unknown scales — `HEIGHT_SCALE` (greyscale→meters) and
  `METERS_PER_TEXEL` (1024² grid→world size) — visually against remembered scale, then fix
  them as constants in `config.ts`.
- Apply the `.trn` environment scalars: `water_height`, `filter` RGB tint, `sky_height`,
  `horizon`, `sun_slope`.
- **Candidate maps:** Green Mile / Balnakiel / 1stLook / River (EXP2b, fully present as
  colormap+heightmap), or any of the 27 TerrainPack maps (Desert3, snow1, the 20 Land
  Warrior maps). Grass is *not* required for this milestone.

### Phase 2 — Grass renderer
- Relief-mapped ("grass slab") mid/far-field grass — the primary density layer, driven by
  the baked `grassHeightField`.
- Compute-shader near-field 3D blade instancing (~0–15m) for tactile/interactive detail.
- Distance crossfade between the two.
- **Data note:** buildable *now* using the bundled `ct1_dm`/`ct2_dm` stretch strips; the
  classic grass set (`dfdg1_dm`) used by the marquee maps needs a base-game `.pff` we don't
  currently have (`06-...md` §7). Not a blocker — validate the tech on what we have.
- Full design rationale in `03-terrain-and-grass-rendering-design.md`.

### Phase 3 — Concealment system
- Decoupled gameplay heightfield sampled independently of the render path, for
  line-of-sight / prone-concealment logic at any range. Reads the *same*
  `grassHeightField` as Phase 2. Full design in `04-concealment-system-design.md`.

### Phase 4 — Integration
- First-person controller, physics (rapier or cannon-es), basic AI/objectives.
- ECS (bitECS) as entity count grows (`05-...md` §3).

### Phase 5 — Polish
- Wind animation tuning, LOD blend tuning, color-matching at draw distance, audio.

## 7. Open questions — status

**Resolved** by the July 2026 extraction (`06-asset-extraction-findings.md`):

- ~~Exact resolution of heightmaps/colormaps~~ → **1024×1024** for both (colormap JPEG RGB,
  heightmap PCX 8-bit greyscale). Not tiled.
- ~~Fixed vs. per-terrain detail-map palette~~ → **authored per-terrain**; the palette
  *index* is the key into the 256-tile detail strips (Green Mile uses 62 distinct indices).
- ~~Relationship between the detail elevation strip and per-texel grass height~~ → the strip
  is **256 stacked 64×64 greyscale tiles**; `detail_map[x,z]` selects tile _i_, whose
  greyscale is that texel's grass **stretch height**. A per-index lookup, not a linear scale.

**Still open:**

- **Vertical/horizontal world scale.** Greyscale→meters for the heightmap (`HEIGHT_SCALE`)
  and the 1024² grid's real-world extent (`METERS_PER_TEXEL`). Calibrate visually during
  Phase 1.5; the ~800m concealment range is a useful sanity anchor.
- **Stretch-height→world-units scale** for `detail_elev` (same calibration exercise).
- **The classic grass set `dfdg1_dm`/`dfdg1_cm`**, referenced by Balnakiel/Green
  Mile/1stLook/River but only present in a base-game `.pff`. Substitute `ct1_dm`/`ct2_dm`
  until a base DF2 install is available.
- Whether `char_data` (always the `_cm` strip in observed data) carries anything beyond the
  detail-color strip.
