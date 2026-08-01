# Engine Architecture & Tech Stack

> **AS BUILT (July 2026).** The stack landed as specified, on these versions: **Vite 8 +
> TypeScript (strict) + React 19 + R3F v9 + drei v10 + three 0.185**, `WebGPURenderer` with
> TSL and the automatic WebGL2 fallback. The project started from a Create React App
> template; **CRA/react-scripts has been removed** — if you find a reference to it anywhere,
> it is stale. Module-by-module reality is in `08-implementation-spec.md`.

## 1. Rendering foundation: Three.js + WebGPURenderer + TSL

- **Three.js `WebGPURenderer`** (production-ready since r171) as the primary renderer,
  with Three.js's own automatic, silent fallback to WebGL2 for browsers lacking WebGPU
  support (WebGPU reached near-universal browser coverage in late 2025; remaining WebGL2-
  only share is estimated ~5%).
- **TSL (Three Shading Language)** for all custom shader work — a single JS-authored node
  graph compiles to WGSL (WebGPU backend) and GLSL (WebGL2 backend) from one source. This
  is what makes the two-layer grass system (see rendering design doc) practical to
  maintain: one shader source, both backends, rather than a hand-maintained GLSL/WGSL fork.
- Compute-shader support (via TSL `instancedArray`/`storage` node types) is used for the
  near-field grass blade pipeline; the far-field relief-mapped grass slab is deliberately
  kept to fragment-shader-only work so it degrades gracefully on the WebGL2 fallback path
  without a separate implementation.
- Existing prior art confirming feasibility at scale in-browser: a public 2026 showcase
  (React Three Fiber + Three.js WebGPU/TSL) renders 1M+ grass blades plus procedural
  terrain live in-browser via compute shaders — validates the compute-blade layer's
  scaling headroom well beyond what this project needs.

## 2. Asset pipeline (offline, Node.js/TypeScript, separate from the runtime engine)

- `df2-extract` CLI: ports `PffArchive.cs`, `TgaConvert.cs`, `PcxConvert.cs`, `File3di.cs`
  logic (see `02-asset-format-specification.md`) from the reference C# implementation to
  TypeScript. Pure format-parsing logic, no native/Windows dependency.
- Pipeline stages:
  1. ✅ `.pff` → raw file blobs (archive unpack)
  2. ✅ Terrain TGA/PCX → PNG (colormap, heightmap, detail map, detail elevation strip).
     Colormap is JPEG and passes through untouched.
  3. ✅ Derived: bake `grassHeightField` texture from detail map + detail elevation strip
     (consumed by both the rendering system and the concealment system — see both
     respective design docs). Output is tagged with its provenance; a bake from a
     substituted strip is refused at load time (`08-...md` §5.3).
  4. ⬜ `.3DI` → glTF (character/vehicle models, textures, materials, sub-object/bone
     hierarchy) — not started.
- Runs entirely as a pre-build step; the web runtime never touches `.pff`/`.3DI`/`.tga`
  directly, only the converted PNG/glTF/JSON output.

## 3. Runtime architecture

- ⬜ **ECS**: a lightweight library (e.g. `bitECS`) to keep entity/component logic
  (player, AI, projectiles, vehicles) manageable as the project grows past the initial
  terrain/grass prototype. Not started — the project is still the prototype.
- ⬜ **Physics**: **Rapier** for player collision, prone/crouch stance
  (feeds directly into the concealment system's stance-to-height mapping — see
  `04-concealment-system-design.md` §4.2), vehicles, rigid bodies, and scene queries.
  Not started; stance heights currently exist only as `STANCE_EYE` in the camera rig.
  Fast rifle rounds already use a custom pooled 120 Hz fixed-step solver with swept
  world-query segments rather than one dynamic rigid body per bullet; see `docs/10`.
- **Player and vehicle controllers**: decision pending a bounded ecctrl spike. Rapier
  remains the selected physics engine; the baseline fallback is project-owned controllers
  built against Rapier primitives. Ecctrl may be adopted only behind project-owned motor
  adapters, with input, camera, GLTF/animation, and React state kept out of gameplay truth.
  The decision gate measures stance and terrain behavior, representative vehicle handling,
  fixed-tick command/replay support, serializable reconciliation state, headless-authority
  feasibility, and 32/64-entity cost. Primitive proxy meshes are sufficient. See
  `plans/2026-08-01-ecctrl-player-vehicle-controller-spike-design.md`.
  ⬜ Not started. What exists today is a camera rig only — `FlyControls.tsx`, free-fly
  plus an on-foot mode that clamps to the surface at a stance eye height. No physics or
  collision exists beyond that clamp.
- No networking in v1 (see project overview, non-goals) — **but** the intended end state is
  a 64+ player shooter, deliberately on hold. Don't build for it; don't foreclose it
  either (`01-...md` §2).

### Local FPS/combat slice — as built

`src/fps/` is intentionally a small mutable-system architecture, not an ECS. Weapon and
loadout state, authoritative sway, ballistics, penetration, and target health live outside
React. R3F mounts the current first-person presentation and publishes throttled HUD
snapshots.

Terrain collision is already renderer-independent: `HeightfieldWorldQuery` traverses the
canonical CPU field, `ThreeWorldQuery` spatially indexes explicit simplified colliders, and
`CompositeWorldQuery` returns the nearer hit. Rapier remains selected for later character,
vehicle, and rigid-body work; ecctrl is a candidate controller layer over Rapier, not a
replacement physics engine. Neither is required for fast bullets or static terrain shots.

The detailed as-built contract is `10-fps-combat-implementation-spec.md`.

## 4. Terrain rendering module

- ✅ Chunked/LOD heightmap mesh (geomipmapping or clipmap), streamed by camera distance.
  Built as a camera-centred **infinite** window — see rendering design doc §5, AS BUILT.
- ✅ Textured with extracted colormap. ⬜ Heightmap does not yet drive physics collision
  (no physics engine); it drives mesh geometry and the camera's ground clamp.
- ⬜ Optional literal Voxel Space raycast "authentic mode": a full-screen fragment shader
  raymarching the heightmap texture directly, toggleable, not the default renderer.

## 5. Grass rendering module

Two TSL-authored layers, both consuming the shared `grassHeightField` (and companion
color/density textures) from the asset pipeline:

- **Far/mid layer**: fragment-shader columnar march (fragment-only, no compute dependency).
  ✅ built as `src/df2/GrassMaterial.ts`. The approach diverges from the "relief-mapped
  slab" originally specified — see the AS BUILT table in rendering design doc §4.1. The
  fragment-only property held, which is why it works on the WebGL2 fallback.
- **Near layer**: TSL compute-shader blade instancing with layered culling and LOD blade
  complexity (rendering design doc §4.2), WebGL2-fallback path reduces instance density
  and/or substitutes shell texturing. ⬜ not started.
- Crossfade band between the two (rendering design doc §4.3). ⬜ not started.

## 6. Concealment module

- ⬜ Independent system, not part of the rendering pipeline, consuming the same
  `grassHeightField` texture (see `04-concealment-system-design.md`). **Not built.**
  The mechanic is demonstrated by pixel-counting in `tools/grass-rig` (`07-...md` §8), which
  is evidence the approach works — not an implementation of it.
- ⬜ Exposed as a query API (`isConcealed(observer, target): boolean`) usable by both player-
  facing feedback (if any) and AI visibility checks.
- ✅ The precondition is in place: `Heightfield.ts` is renderer-free and the canopy field is
  baked offline, so this module can be written without touching the render path.

## 7. Directory/module layout (proposed)

> **AS BUILT — terrain has not moved, and FPS is now a separate bounded module.** Terrain
> engine code remains in the Phase-1 spike directory `src/df2/` (module map: `08-...md`
> §3), while local combat is under `src/fps/` (module map: `10-...md` §8). The layout below is still
> the target; migrate toward it as Phase 2+ lands. One rename to carry over when you do:
> `relief-slab.ts` should become something like `columnar-march.ts`, since that is what the
> shader actually is (rendering design doc §4.1, AS BUILT).
>
> The one boundary already enforced in the spike, and the one worth protecting through any
> reorganisation: **`Heightfield.ts` imports nothing from Three.js.** It is the seed of the
> gameplay/concealment field and has to be samplable with no renderer present — including
> server-side, if multiplayer ever happens.

```
/tools/df2-extract/          # Node/TS asset pipeline CLI (Phase 0)
/src/engine/
  terrain/                   # chunked mesh, LOD, heightfield sampling
  grass/
    columnar-march.ts        # far/mid TSL fragment shader layer
    compute-blades.ts        # near-field TSL compute layer
  concealment/
    heightfield-query.ts     # line-of-sight sampling (shared data w/ grass/)
  physics/
  controller/
/src/game/                   # ECS components/systems, entities
/src/fps/                    # current local-first mutable combat slice (as built)
/assets/converted/           # pipeline output (PNG/glTF/JSON), gitignored if sourced
                              # from non-redistributable retail data
```

## 8. Compatibility/performance targets (initial)

> **AS BUILT — these targets are unmeasured.** No trustworthy GPU numbers exist for any part
> of this project. Agent/CI containers here have no GPU, so WebGPU init fails and everything
> runs on SwiftShader; and `renderAsync` returns on submission, so even on real hardware the
> figures are CPU-side without timestamp queries. Draw-call and triangle counts are exact.
> The HUD reports which backend actually initialised — check it before believing any frame
> time (`08-...md` §10).

- Primary target: desktop, WebGPU path, 60fps at draw distances supporting the ~800m
  concealment-relevant sniping range.
- Fallback target: WebGL2, reduced near-field grass density, columnar-march far layer
  unaffected (see rendering design doc §4.1) — this is the reason that layer was
  deliberately kept compute-independent.
- Mobile: out of scope for v1 but the architecture (fragment-only far layer, tunable
  near-field instance budget) leaves room for a future mobile tier without a rewrite.
