# 05 — Engine Architecture & Tech Stack

The runtime stack, why each piece was chosen, and how the code in `src/df2/` is laid out.

---

## 1. Stack summary

| Layer | Choice | Rationale |
| --- | --- | --- |
| Renderer | **Three.js `WebGPURenderer`** | Modern compute + node materials; production-ready since r171. Automatic, silent fallback to WebGL2 for browsers without WebGPU (~5%). |
| Shading | **TSL (Three Shading Language)** | One JS-authored shader graph compiles to **both** WGSL (WebGPU) and GLSL (WebGL2). No dual shader codebase. |
| App shell | **React + React Three Fiber** | Declarative scene graph, hooks-based lifecycle, inherited from the starter this repo forked. |
| Helpers | **@react-three/drei** | `MapControls`, loaders, misc. |
| Asset pipeline | **Node.js + TypeScript CLI** (`df2-extract`, Phase 0) | Runs offline as a build step, fully decoupled from the runtime engine. |
| Physics (Phase 4) | **rapier** (preferred) or cannon-es | WASM, deterministic-ish, good R3F bindings via `@react-three/rapier`. |

---

## 2. Why WebGPU + TSL specifically

- **Compute shaders** are needed for the Phase 2 near-field grass (scatter + wind on the
  GPU) and are first-class in WebGPU. WebGL2 has no compute; the fallback path uses a
  reduced grass model, which TSL lets us express as graph branches rather than a separate
  shader.
- **Node materials** compose cleanly: the terrain's biome blend, the grass relief term, and
  fog are all graph nodes on standard materials, so they keep PBR lighting and shadows for
  free instead of reimplementing a lighting model in raw shader code.
- **Single source of truth:** authoring in TSL means we never hand-maintain parallel WGSL
  and GLSL. This was the deciding factor over hand-written WGSL.

---

## 3. Renderer bootstrap

`src/components/GameCanvas.js` (generalized from the starter's canvas) owns WebGPU setup:

- Imports `three/webgpu` and `extend(THREE)` so R3F knows the node classes.
- Constructs `WebGPURenderer` in the Canvas `gl` callback, calls `renderer.init()`, and
  only flips the R3F frameloop from `"never"` to `"always"` once init resolves — this avoids
  rendering before the device is ready.
- Accepts a `camera` prop so scenes can set world-appropriate near/far/position (terrain
  needs a far plane in the thousands of meters, unlike the original interior demo).

If WebGPU is unavailable, Three.js transparently backs the same renderer with WebGL2; no
app-level branching required.

---

## 4. Module layout (`src/df2/`)

```
src/df2/
  config.js          # world constants: size, chunking, LOD, height/fog/water scales
  noise.js           # deterministic hash + value noise + fBm (no deps)
  Heightfield.js     # CPU heightfield: precomputed fBm grid, bilinear sample(), analytic normal()
  terrainGeometry.js # builds one chunk's BufferGeometry (grid + skirt) from a Heightfield
  TerrainMaterial.js # TSL MeshStandardNodeMaterial: slope/height biome blend
  Terrain.js         # R3F component: chunk grid, per-frame LOD selection, geometry cache
  DF2Scene.js        # scene composition: lights, fog, water, <Terrain/>, MapControls
```

Design rules:

- **`config.js` is the single place** for world scale, chunk count, LOD table, height/water
  scales. Swapping synthetic data for real extracted terrain (Phase 4) should touch data and
  `config.js`, not the renderer.
- **`Heightfield.js` is engine-agnostic** — no Three.js import. It is both the mesh's height
  source and the seed of the Phase 3 gameplay heightfield (`04-...md`), which is why it lives
  apart from `terrainGeometry.js`.
- **`Terrain.js` manages meshes imperatively** inside a `useMemo`'d group and mutates
  `mesh.geometry` in `useFrame`, bypassing React reconciliation on the hot path. Geometries
  are cached per `(chunk, lod)` and reused.

---

## 5. Data flow

```
config.js ──▶ Heightfield (fBm grid)
                 │  sample(x,z), normal(x,z)
                 ▼
          terrainGeometry ──▶ per-(chunk,lod) BufferGeometry ──┐
                                                               ▼
Terrain.js (per-frame LOD pick) ──▶ meshes ──▶ TerrainMaterial (TSL) ──▶ WebGPURenderer
```

When real assets land, `Heightfield`'s fBm grid is replaced by a sampler over the decoded
heightmap PNG, and `TerrainMaterial`'s procedural color is replaced by a colormap texture
sample — both behind the same interfaces.

---

## 6. What the current scaffold does and does not do

**Does:** chunked terrain, real distance-based LOD with a geometry cache, skirt crack-hiding,
analytic normals for stable cross-LOD lighting, TSL biome material, sun + hemisphere light,
distance fog, a water plane, and an orbit/map camera over synthetic fBm terrain.

**Does not yet:** load real assets (Phase 0/4), grass of any kind (Phase 2), concealment
queries (Phase 3), shadows, the authentic-mode raycaster, or physics. These are called out in
`01-...md` §8 and their respective design docs.

---

## 7. Build & run

Inherited Create-React-App scripts:

```
npm install
npm start      # dev server at localhost:3000
npm run build  # production build (used as the CI/scaffold sanity check)
```

No pipeline dependencies are added yet; `df2-extract` (Phase 0) will live in its own
`tools/` workspace so the runtime bundle stays lean.
