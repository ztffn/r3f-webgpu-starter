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

**Phase 1 — chunked/LOD terrain scaffold — is in.** It runs on synthetic fBm terrain (no
game assets required):

- Chunked heightfield mesh with real distance-based per-chunk LOD and a geometry cache.
- Edge "skirts" to hide cracks between differing-LOD chunks.
- Analytic normals from the heightfield gradient → stable lighting across LOD levels.
- A TSL terrain material blending sand/grass/rock/snow biomes by height and slope.
- Sun + hemisphere lighting, distance fog, and a water plane.
- Map-style camera (orbit / pan / zoom) and a wireframe toggle.

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

## Source layout

```
src/df2/
  config.ts          world constants (size, chunking, LOD, height/fog/water)
  noise.ts           deterministic value noise + fBm
  Heightfield.ts     CPU heightfield: bilinear sample() + analytic normal()
  terrainGeometry.ts per-chunk BufferGeometry (grid + skirt)
  TerrainMaterial.ts TSL biome material
  Terrain.tsx        chunk grid + per-frame LOD selection
  DF2Scene.tsx       scene composition (lights, fog, water, camera)
src/components/
  GameCanvas.tsx     WebGPU + R3F canvas bootstrap (async WebGPU init)
  Overlay.tsx        UI overlay
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
WebGPU is unavailable.

## Roadmap (next)

- **▶ Phase 1.5 — real-map demo (next milestone):** decode a real terrain's heightmap +
  colormap into the existing chunked renderer, calibrate world scale, apply the `.trn`
  environment scalars. Validates "does this feel like DF2?" before any grass work.
- **Phase 0 (remainder)** — PCX/TGA decoders → PNG, and bake the `grassHeightField`.
- **Phase 2** — grass: relief-mapped far field + compute-instanced near-field blades.
- **Phase 3** — concealment / line-of-sight, reading the same `grassHeightField`.
- **Phase 4** — first-person controller, physics, ECS, AI/objectives.

## Credits

The WebGPU + R3F canvas bootstrap is derived from Anderson Mancini's
[r3f-webgpu-starter](https://github.com/ektogamat/r3f-webgpu-starter).
