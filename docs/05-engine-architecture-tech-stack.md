# 05 — Engine Architecture & Tech Stack

The runtime stack, why each piece was chosen, and how the code in `src/df2/` is laid out.

---

## 1. Stack summary

| Layer | Choice | Rationale |
| --- | --- | --- |
| Build tool | **Vite** (+ `@vitejs/plugin-react`) | Fast HMR — the thing that actually matters when iterating on terrain shaders. Replaces the deprecated Create React App / react-scripts the starter shipped with. |
| Language | **TypeScript** (strict) | Typed heightfield/chunk/LOD interfaces; the asset pipeline (Phase 0) is already specced in TS. |
| Renderer | **Three.js `WebGPURenderer`** (r185) | Modern compute + node materials. Automatic, silent fallback to WebGL2 for browsers without WebGPU (~5%). |
| Shading | **TSL (Three Shading Language)** | One JS-authored shader graph compiles to **both** WGSL (WebGPU) and GLSL (WebGL2). No dual shader codebase. |
| App shell | **React 19 + React Three Fiber v9** | Declarative scene graph, hooks-based lifecycle. R3F v9 supports an async `gl` factory, which the WebGPU init path uses. |
| Helpers | **@react-three/drei v10** | `MapControls`, `Loader`, misc. |
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

`src/components/GameCanvas.tsx` owns WebGPU setup:

- Imports `three/webgpu` and `extend(THREE)` so R3F knows the node classes.
- Uses R3F v9's **async `gl` factory**: constructs `WebGPURenderer` and `await`s
  `renderer.init()` before the first render, so we never draw before the device is ready.
- Accepts a `camera` prop so scenes can set world-appropriate near/far/position (terrain
  needs a far plane in the thousands of meters).

If WebGPU is unavailable, Three.js transparently backs the same renderer with WebGL2; no
app-level branching required.

---

## 4. Module layout (`src/df2/`)

```
src/df2/
  config.ts          # world constants: size, chunking, LOD, height/fog/water scales
  noise.ts           # deterministic hash + value noise + fBm (no deps)
  Heightfield.ts     # CPU heightfield: precomputed fBm grid, bilinear sample(), analytic normal()
  terrainGeometry.ts # builds one chunk's BufferGeometry (grid + skirt) from a Heightfield
  TerrainMaterial.ts # TSL MeshStandardNodeMaterial: slope/height biome blend
  Terrain.tsx        # R3F component: chunk grid, per-frame LOD selection, geometry cache
  DF2Scene.tsx       # scene composition: lights, fog, water, <Terrain/>, MapControls
```

Design rules:

- **`config.ts` is the single place** for world scale, chunk count, LOD table, height/water
  scales. Swapping synthetic data for real extracted terrain (Phase 4) should touch data and
  `config.ts`, not the renderer.
- **`Heightfield.ts` is engine-agnostic** — no Three.js import. It is both the mesh's height
  source and the seed of the Phase 3 gameplay heightfield (`04-...md`), which is why it lives
  apart from `terrainGeometry.ts`.
- **`Terrain.tsx` manages meshes imperatively** inside a `useMemo`'d group and mutates
  `mesh.geometry` in `useFrame`, bypassing React reconciliation on the hot path. Geometries
  are cached per `(chunk, lod)` and reused.

---

## 5. Data flow

```
config.ts ──▶ Heightfield (fBm grid)
                 │  sample(x,z), normal(x,z)
                 ▼
          terrainGeometry ──▶ per-(chunk,lod) BufferGeometry ──┐
                                                               ▼
Terrain.tsx (per-frame LOD pick) ──▶ meshes ──▶ TerrainMaterial (TSL) ──▶ WebGPURenderer
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

Vite scripts:

```
npm install
npm run dev        # dev server at localhost:3000
npm run build      # tsc --noEmit + vite build -> /dist (CI/scaffold sanity check)
npm run preview    # serve the production build
npm run typecheck  # tsc --noEmit
```

No pipeline dependencies are added yet; `df2-extract` (Phase 0) will live in its own
`tools/` workspace so the runtime bundle stays lean.
