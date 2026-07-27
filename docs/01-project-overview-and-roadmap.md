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
- Terrain data per map is a small set of flat 2D image-like files packed into `.pff`
  archives: colormap, heightmap (greyscale), detail map (8-bit/256-color, grass/sand
  zoning), a detail color texture strip, a detail elevation greyscale strip, plus
  ancillary sky/water/lighting parameters. Full byte-level spec in
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

### Phase 0 — Asset pipeline (blocked on: terrain files from contact; retail copy optional)
- Port `PffArchive.cs`, `TgaConvert.cs`, `PcxConvert.cs`, `File3di.cs` logic to
  TypeScript/Node as a CLI (`df2-extract`).
- Validate against TXP/EXP2b `.pff` archives once available.
- Confirm terrain file naming/extension convention empirically (currently believed to be
  plain TGA/PCX inside the archive — no dedicated terrain binary format is expected, see
  `02-asset-format-specification.md` §5).
- Output: PNG heightmap/colormap/detail-map/detail-elevation-strip sets per terrain, and
  `.3DI` → glTF conversion for a first test character/vehicle model.

### Phase 1 — Terrain renderer (unblocked, can start immediately with synthetic data) ✅ *scaffolded*
- Chunked/LOD heightmap mesh renderer in Three.js, textured with extracted (or
  placeholder) colormap.
- Optional literal Voxel Space raycast "authentic mode" as a fragment-shader toggle.

> **Status:** an initial Phase 1 scaffold now lives in `src/df2/` and runs on synthetic
> fBm terrain. See §8 below and `05-engine-architecture-tech-stack.md` §6 for what is and
> is not yet implemented.

### Phase 2 — Grass renderer (unblocked, can start immediately with synthetic density data)
- Relief-mapped ("grass slab") mid/far-field grass — the primary density layer.
- Compute-shader near-field 3D blade instancing (~0–15m) for tactile/interactive detail.
- Distance crossfade between the two.
- Full design rationale in `03-terrain-and-grass-rendering-design.md`.

### Phase 3 — Concealment system
- Decoupled gameplay heightfield sampled independently of the render path, for
  line-of-sight / prone-concealment logic at any range. Full design in
  `04-concealment-system-design.md`.

### Phase 4 — Integration
- Swap synthetic data for real extracted terrain assets (from Phase 0) once available.
- First-person controller, physics (rapier or cannon-es), basic AI/objectives.

### Phase 5 — Polish
- Wind animation tuning, LOD blend tuning, color-matching at draw distance, audio.

## 7. Open questions to resolve once real terrain files arrive

- Exact resolution of DF2/TXP/EXP2 heightmaps and colormaps (Comanche's own Voxel Space
  used 1024×1024; DF2 terrains are reported larger/tiled — needs confirmation).
- Whether the detail map's 8-bit palette indices map to a fixed, documented palette
  (needed to correctly parse grass-vs-sand-vs-rock zoning) or an authored-per-terrain
  palette.
- Exact relationship between the "detail elevation strip" and per-texel grass height
  (linear scale? palette-index-to-height lookup table?).

## 8. Current implementation status (this repo)

| Area | Status | Where |
| --- | --- | --- |
| WebGPU + R3F canvas bootstrap | ✅ inherited from starter | `src/components/GameCanvas.js` |
| Synthetic heightfield (fBm) with CPU-side sampler + analytic normals | ✅ | `src/df2/Heightfield.js`, `src/df2/noise.js` |
| Chunked terrain mesh generation with edge skirts | ✅ | `src/df2/terrainGeometry.js` |
| Distance-based per-chunk LOD selection | ✅ | `src/df2/Terrain.js` |
| TSL terrain material (slope/height biome blend) | ✅ | `src/df2/TerrainMaterial.js` |
| Scene composition (sun/sky/hemisphere light, fog, water plane) | ✅ | `src/df2/DF2Scene.js` |
| Real asset ingestion (Phase 0) | ⛔ blocked on files | — |
| Grass (Phase 2) | ⬜ not started | — |
| Concealment (Phase 3) | ⬜ not started | — |
| "Authentic mode" raycaster | ⬜ documented, not built | `03-...md` §7 |

The CPU-side heightfield in `src/df2/Heightfield.js` is deliberately decoupled from the GPU
mesh path so it can later serve as the Phase 3 gameplay heightfield without a rewrite.
