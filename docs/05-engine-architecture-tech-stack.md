# Engine Architecture & Tech Stack

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
  1. `.pff` → raw file blobs (archive unpack)
  2. Terrain TGA/PCX → PNG (colormap, heightmap, detail map, detail elevation strip)
  3. Derived: bake `grassHeightField` texture from detail map + detail elevation strip
     (consumed by both the rendering system and the concealment system — see both
     respective design docs)
  4. `.3DI` → glTF (character/vehicle models, textures, materials, sub-object/bone
     hierarchy)
- Runs entirely as a pre-build step; the web runtime never touches `.pff`/`.3DI`/`.tga`
  directly, only the converted PNG/glTF/JSON output.

## 3. Runtime architecture

- **ECS**: a lightweight library (e.g. `bitECS`) to keep entity/component logic
  (player, AI, projectiles, vehicles) manageable as the project grows past the initial
  terrain/grass prototype.
- **Physics**: `rapier` or `cannon-es` for player collision, prone/crouch stance
  (feeds directly into the concealment system's stance-to-height mapping — see
  `04-concealment-system-design.md` §4.2), and basic vehicle/projectile physics.
- **First-person controller**: custom, built against the physics engine's character
  controller primitives.
- No networking in v1 (see project overview, non-goals).

## 4. Terrain rendering module

- Chunked/LOD heightmap mesh (geomipmapping or clipmap), streamed by camera distance.
- Textured with extracted colormap; heightmap drives both visual mesh geometry and
  physics collision.
- Optional literal Voxel Space raycast "authentic mode": a full-screen fragment shader
  raymarching the heightmap texture directly, toggleable, not the default renderer.

## 5. Grass rendering module

Two TSL-authored layers, both consuming the shared `grassHeightField` (and companion
color/density textures) from the asset pipeline:

- **Far/mid layer**: fragment-shader relief-mapped grass slab (fragment-only, no compute
  dependency — see rendering design doc §4.1).
- **Near layer**: TSL compute-shader blade instancing with layered culling and LOD blade
  complexity (rendering design doc §4.2), WebGL2-fallback path reduces instance density
  and/or substitutes shell texturing.
- Crossfade band between the two (rendering design doc §4.3).

## 6. Concealment module

- Independent system, not part of the rendering pipeline, consuming the same
  `grassHeightField` texture (see `04-concealment-system-design.md`).
- Exposed as a query API (`isConcealed(observer, target): boolean`) usable by both player-
  facing feedback (if any) and AI visibility checks.

## 7. Directory/module layout (proposed)

```
/tools/df2-extract/          # Node/TS asset pipeline CLI (Phase 0)
/src/engine/
  terrain/                   # chunked mesh, LOD, heightfield sampling
  grass/
    relief-slab.ts           # far/mid TSL fragment shader layer
    compute-blades.ts        # near-field TSL compute layer
  concealment/
    heightfield-query.ts     # line-of-sight sampling (shared data w/ grass/)
  physics/
  controller/
/src/game/                   # ECS components/systems, entities
/assets/converted/           # pipeline output (PNG/glTF/JSON), gitignored if sourced
                              # from non-redistributable retail data
```

## 8. Compatibility/performance targets (initial)

- Primary target: desktop, WebGPU path, 60fps at draw distances supporting the ~800m
  concealment-relevant sniping range.
- Fallback target: WebGL2, reduced near-field grass density, relief-mapped far layer
  unaffected (see rendering design doc §4.1) — this is the reason that layer was
  deliberately kept compute-independent.
- Mobile: out of scope for v1 but the architecture (fragment-only far layer, tunable
  near-field instance budget) leaves room for a future mobile tier without a rewrite.
