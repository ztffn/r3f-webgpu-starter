# Delta Force 2 — Web Port

A browser-based reconstruction of **Delta Force 2** (NovaLogic, 1999), focused on
faithfully reproducing its two defining technical traits: the **Voxel Space 32** heightfield
terrain and its signature concealing **tall grass**.

This is a hobby/reconstruction project, not a commercial release.

## Stack

**Vite + TypeScript + React 19**, rendering with **Three.js `WebGPURenderer`** and **TSL**
shaders via **React Three Fiber v9** / **drei v10**. Three.js falls back to WebGL2
automatically where WebGPU is unavailable (verified: the terrain renders cleanly on the
fallback path). The legacy Create React App / react-scripts setup has been removed.

## Status

**Phase 1 terrain and the Phase 1.5 real-map demo are in**, plus a first pass at the
columnar grass. With prepared assets present it renders a real DF-era map; without them it
falls back to synthetic fBm and needs no game data at all.

- Chunked heightfield mesh with distance-based per-chunk LOD and a geometry cache.
- **Infinite tiling** — the window of chunks re-centres on the camera and geometry is cached
  by *wrapped* chunk index, so the map repeats forever with no edge (as DF2's did).
- Edge "skirts" to hide cracks between differing-LOD chunks.
- Analytic normals from the heightfield gradient → stable lighting across LOD levels.
- A TSL terrain material blending sand/grass/rock/snow biomes by height and slope.
- Columnar grass: a per-fragment distance-adaptive march over a canopy field, writing its own
  depth so it sorts against terrain. See [`docs/07`](./docs/07-grass-visual-reference.md).
- Sun + hemisphere lighting, distance fog, and a water plane.
- Free-fly / on-foot camera with stand / crouch / prone eye heights, and a HUD carrying
  position, AGL, frame time, draw calls and which backend actually initialised.

Known open artifact: at eye height with the camera pitched down, chunk skirts can show as a
near-black band with sky beyond it. It is terrain, not grass — diagnosis and evidence in
[`docs/07`](./docs/07-grass-visual-reference.md) §9.

The CPU-side heightfield (`src/df2/Heightfield.ts`) is deliberately decoupled from the render
mesh so it can later serve as the gameplay/concealment field without a rewrite.

### Real asset extraction — done

Real DF-era terrain data has been extracted from community modding installers (statically,
no Wine needed): **27 terrains** from a 2003 TerrainPack (DF1 desert/snow, 20 Land Warrior
maps) and **9** from the TerraNova EXP2b expansion (Green Mile, Balnakiel, 1stLook, River…).
Confirmed: colormap = JPEG 1024², heightmap = PCX 1024² 8-bit, plus a per-texel detail map
and 256-tile grass **stretch-height** strips. `tools/df2-extract` unpacks `.pff` archives and
`.trn` manifests. Findings: [`docs/06`](./docs/06-asset-extraction-findings.md).

Extracted assets are **not** committed (NovaLogic + community authorship).

See [`docs/`](./docs) for the full design:

| Doc | Topic |
| --- | --- |
| [`01`](./docs/01-project-overview-and-roadmap.md) | Project overview & phased roadmap |
| [`02`](./docs/02-asset-format-specification.md) | PFF/TGA/PCX/`.3DI` + terrain formats |
| [`03`](./docs/03-terrain-and-grass-rendering-design.md) | Terrain & grass rendering design |
| [`04`](./docs/04-concealment-system-design.md) | Concealment / line-of-sight system |
| [`05`](./docs/05-engine-architecture-tech-stack.md) | Engine architecture & tech stack |
| [`06`](./docs/06-asset-extraction-findings.md) | **Asset extraction findings (ground truth)** |
| [`07`](./docs/07-grass-visual-reference.md) | Grass measurement methodology & open artifacts |
| [`08`](./docs/08-implementation-spec.md) | **Implementation spec (as-built)** — start here to change code |

## Source layout

```
src/df2/
  config.ts          world constants (size, chunking, LOD, height/fog/water)
  noise.ts           deterministic value noise + fBm
  Heightfield.ts     CPU heightfield: bilinear sample() + analytic normal()
  terrainGeometry.ts per-chunk BufferGeometry (grid + skirt)
  TerrainMaterial.ts TSL biome material
  GrassMaterial.ts   TSL columnar grass (fragment march + depth output)
  loadTerrain.ts     runtime loader for prepared assets, with synthetic fallback
  Terrain.tsx        infinite chunk window + per-frame LOD selection
  FlyControls.tsx    free-fly / on-foot camera, stance eye heights
  PerfMonitor.tsx    frame time, draw calls, backend
  DF2Scene.tsx       scene composition (lights, fog, water, camera)
src/components/
  GameCanvas.tsx     WebGPU + R3F canvas bootstrap (async WebGPU init)
  Hud.tsx            instrument-panel HUD
src/main.tsx         entry
```

`src/df2/` is the current Phase-1 spike. The **target** module layout is the one in
[`docs/05`](./docs/05-engine-architecture-tech-stack.md) §7 (`/tools/df2-extract`,
`/src/engine/{terrain,grass,concealment,physics,controller}`, `/src/game/` for ECS). The
scaffold will be reorganized toward that layout as Phase 2+ lands — today's `Heightfield.ts`
→ `engine/terrain`, and the fBm field becomes the shared source the `engine/concealment`
line-of-sight query reads.

## Getting started

Install [Node.js](https://nodejs.org/en/download/) (18+), then:

```shell
npm install
npm run dev        # Vite dev server at localhost:3000
npm run build      # typecheck + production build to /dist
npm run preview    # serve the production build
npm run typecheck  # tsc --noEmit
```

A WebGPU-capable browser is recommended; Three.js falls back to WebGL2 automatically where
WebGPU is unavailable. The HUD shows which backend actually initialised — worth checking
before drawing any conclusion from the frame times next to it.

### Controls

| | |
| --- | --- |
| Drag | look |
| `W` `A` `S` `D` | move |
| `Q` / `E` | descend / climb (flying only) |
| Wheel | flight speed |
| `Shift` | ×4 boost |
| `G` | toggle on-foot / fly |
| `X` `C` `Z` | stand / crouch / prone (drops you to the ground) |

## Deploying a test build

The site is configured for [Netlify](https://netlify.com) in `netlify.toml`. There are two
paths and they do **not** produce the same build:

**CLI deploy — the one that carries the real map.**

```shell
npm run build
npx netlify deploy --prod --dir=dist
```

Vite copies `public/assets/` into `dist/`, so a machine that has prepared terrain assets
uploads them with the build. Nothing extracted ever enters git; the upload comes off your
disk. This is the path to use for anything you want to actually fly around in.

**Git-connected build — shell only.** Netlify runs `npm run build` on its own runners, which
have no prepared assets (they are git-ignored — see below). The site builds and runs, but
`loadTerrain()` finds nothing and falls back to synthetic fBm terrain. Fine for checking the
HUD and the deploy pipeline, useless for judging whether the terrain feels like DF2.

Extracted game assets are **not** committed and should not be. `/assets/`, `/public/assets/`,
`*.pff` and `*.trn` are git-ignored — NovaLogic owns the base game data, and the community
expansion terrains are third-party work. Prepare assets locally with
`tools/df2-extract/prepare-terrain.mjs`.

## Roadmap (next)

- **▶ Now:** close the skirt artifact above, then calibrate `HEIGHT_SCALE` /
  `METERS_PER_TEXEL` against the real game — they are still placeholders, so "does this feel
  like DF2?" cannot be answered honestly yet.
- **Phase 2** — grass: measure the current columnar march against the reference screenshots
  (it is still flatter than the real thing, `docs/07` §7), then compute-instanced near-field
  blades.
- **Phase 3** — concealment / line-of-sight, reading the same `grassHeightField`.
- **Phase 4** — first-person controller, physics, ECS, AI/objectives.

## Credits

The WebGPU + R3F canvas bootstrap is derived from Anderson Mancini's
[r3f-webgpu-starter](https://github.com/ektogamat/r3f-webgpu-starter).
