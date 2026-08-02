# Foliage / vegetation — design, verified corrections, and what is now built

**Status:** exploratory branch `claude/foliage-rendering-research-jtr43e`. A working
prototype exists behind `?foliage=1`; nothing about the default build changed.
**Scope:** bushes and trees. Grass is a different system and is not touched
(`docs/03` §4.1, `src/df2/GrassMaterial.ts`).

This document exists because a research memo was handed in as the starting point. Section 1
records where that memo is right, where it is wrong **against this stack specifically**, and
where it asks a question this project has already answered for a different subsystem.
Sections 2–6 are the design. Section 7 is the measurement protocol, which is the part that
still needs a machine with a GPU.

---

## 0. The one-paragraph version

Vegetation is authored as **records, not objects**: a deterministic placement field keyed on
the wrapped cell index, so it tiles with the terrain, reproduces on any machine, and can be
sampled by a server with no renderer. Those records feed three independent consumers — an
instanced renderer bucketed per spatial cell, an analytic trunk query for ballistics, and
(deferred) the concealment query in `docs/04`. The renderer uses **cell-local
`InstancedMesh` buckets with a cell-uniform LOD swapped by geometry pointer**, which gets
BatchedMesh's one real advantage without paying its cost on this backend. The alpha path is
**MASK**, with alpha-to-coverage, alpha hash and BLEND switchable at runtime because that
choice is hardware-dependent and nobody here has measured it yet.

---

## 1. The research memo, checked

Everything below marked VERIFIED was read out of `node_modules/three` at 0.185.1 — the
version this project actually pins — not from documentation.

### 1.1 Correct, and worth keeping

- **GPU instancing and authoritative gameplay geometry are orthogonal.** Right, and it is
  the framing the rest of this design rests on.
- **`InstancedMesh` frustum-culls as one unit.** VERIFIED: `Frustum.intersectsObject` tests
  `object.boundingSphere` when present and the geometry's otherwise, once per object. One
  visible plant keeps the whole batch submitted. This is the reason to bucket by cell.
- **`MSFT_lod` is not supported.** VERIFIED: `GLTFLoader`'s extension list at 0.185.1 is
  `KHR_materials_*`, `KHR_texture_basisu`, `KHR_/EXT_meshopt_compression`,
  `EXT_mesh_gpu_instancing` — no `MSFT_lod`. A GLB carrying it will not become a working
  LOD chain.
- **`THREE.LOD` per plant is wrong here.** It is an `Object3D` per instance; the whole point
  of this system is that plants are not objects.
- **BLEND is a poor default for leaves**, and `material.dithering` is banding control, not
  LOD fading. Both correct.
- **Alpha-coverage-preserving mips are needed.** Correct, and for this project it is a
  fairness requirement rather than an image-quality one — see §5.

### 1.2 Wrong, or true in general but false on this stack

**"InstancedMesh vs BatchedMesh — both need a representative comparison."**
Not on the backend this project ships. VERIFIED by reading `WebGPUBackend.draw()`:
`object.isBatchedMesh` is special-cased into a **JavaScript loop issuing one `drawIndexed`
per visible sub-object**. There is no multi-draw and no indirect path. The open PR that
would add one (mrdoob/three.js#30645) is still a **draft**, and its own author records that
it measured *slower* than plain `drawIndexed` on Chrome/macOS — this project's primary
target. The WebGL2 fallback is, ironically, better served: it uses `WEBGL_multi_draw` when
the extension is present.

So on WebGPU, BatchedMesh converts a batch into N draw calls and pays for its per-object
culling in exactly the currency it claims to save. The comparison is not worth a benchmark
slot yet; it is worth a re-check when that PR lands.

**"Alpha-to-coverage needs an MSAA-enabled renderer" — true, and already satisfied here.**
VERIFIED twice over: `WebGPUPipelineUtils` sets
`multisample.alphaToCoverageEnabled = material.alphaToCoverage && sampleCount > 1`, and
React Three Fiber's default renderer props include `antialias: true`, which `GameCanvas`
forwards straight into `WebGPURenderer`. **This project has been running 4x MSAA all
along** — including under every grass frame time in `docs/09`. The WebGPU backend clamps the
sample count to 4 or 1; there is no 2x.

A second detail the memo does not mention and that would have cost a session: in
`NodeMaterial`, the alpha-to-coverage path is written *inside* the `alphaTest` branch. Set
`alphaToCoverage` without also setting `alphaTest > 0` and it compiles to nothing. Both are
set together in `applyAlphaMode`, in one place, so a comparison cannot drift between modes.

**"The current renderer's CPU high-precision matrix mode is incompatible with
InstancedMesh."** VERIFIED (`Renderer.highPrecision`'s own doc comment says so) but
irrelevant here: it is off by default and the world is 2048 m across with a camera-centred
chunk window. Filed, not designed around.

**"Cell size must be benchmarked; 16 m is a historical Frostbite value."** Right, and the
memo understates the trap. Cell size has to be swept while everything else is held, and two
things silently move with it if you are not careful. Both were found by sweeping:

- **Window reach.** Expressed in cells, the reach moved with the cell size — 16 m cells
  reached 96 m and 64 m cells reached 384 m while both reported ~400 buckets. The window is
  now specified in **metres**.
- **Plant density.** A fixed candidate-site count per cell makes plants-per-square-metre a
  function of cell size: the first clean sweep produced **8361 plants inside 192 m at a 16 m
  cell and 302 at a 128 m cell**. Placement now uses a site SPACING in metres. Cell size is
  a rendering parameter and must not be able to touch gameplay.

**"Compare four card variants and see which is cheaper."** The experiment as described does
not control its own variable. Built to the memo's descriptions, variant D blocked **0.27** of
horizontal rays through the crown against variant A's **0.52** — D would have measured
cheaper largely because it was a thinner bush. Every variant and every geometric LOD is now
solved to a shared blocking fraction of 0.55 (§4), so the frame times answer the question
that was asked.

Related: the memo's own metric, summed card area × alpha occupancy, is what produced that
confusion. Three crossed planes have three cards' worth of area and roughly one card's worth
of silhouette. The metric used here saturates instead (§4).

### 1.3 Questions this project has already answered elsewhere

- **"Should R3F own individual plants?"** No, and the pattern to copy is already in the
  repo: `Terrain.tsx` preallocates a window of slots and re-points them as the camera moves,
  allocating nothing per frame. `FoliageCells.tsx` is the same device.
- **"How should the asset pipeline deliver LODs — one GLB per species, geometry packs,
  biome packs?"** Premature. There is no vegetation art to ship, the repo must clone and run
  with no art at all (the same argument the synthetic fBm terrain fallback rests on), and
  every variant being drawn on a *different hand-authored texture* would have made the card
  comparison measure the art instead of the construction. Geometry and the leaf texture are
  generated procedurally. The runtime contract is deliberately asset-format-agnostic, so the
  GLB/KTX2 questions can be answered when there is art to answer them about.
- **"Deterministic placement from map seed + cell + rule version."** Correct, and it costs
  nothing to build that way now. It is not netcode and does not start netcode
  (`docs/08` §13 keeps multiplayer on hold); it just declines to foreclose it.

---

## 2. Architecture

```
VegetationField            deterministic records, no Three.js
  |-- FoliageCells         per-cell InstancedMesh buckets, cell-uniform LOD
  |-- VegetationWorldQuery analytic trunk cylinders -> CompositeWorldQuery
  '-- (deferred)           concealment query, docs/04
```

One record set, three consumers. This is the shape `docs/04` §2 argues for and the shape
`docs/08` §11 ("three surfaces where there should be one") records the cost of losing.

### 2.1 Module map

| File | Owns | Must NOT know about |
|---|---|---|
| `foliageConfig.ts` | every vegetation constant | anything |
| `vegetationHash.ts` | exact 32-bit hashing + PRNG | Three.js |
| `species.ts` | the species table, incl. ballistic proxy | Three.js, geometry |
| `VegetationField.ts` | placement, cells, caching | Three.js |
| `alphaMips.ts` | coverage-preserving mip chain | Three.js, DOM |
| `foliageTexture.ts` | procedural leaf texture + occupancy | placement |
| `foliageGeometry.ts` | card variants, LODs, blocking fraction | placement, cells |
| `FoliageMaterial.ts` | TSL material, alpha modes, wind | geometry layout |
| `FoliageCells.tsx` | cell window, buckets, LOD policy | what a plant looks like |
| `VegetationWorldQuery.ts` | trunk ballistics | rendering |
| `FoliageLayer.tsx` | composition, bench flags, counters | all of the above's internals |

`VegetationField.ts`, `species.ts`, `vegetationHash.ts` and `alphaMips.ts` import nothing
from Three.js. That is a rule, not a preference, for the same reason it is a rule for
`Heightfield.ts` (`docs/08` §3): they are the seed of a gameplay field, and a bush that
provides cover has to exist for a server with no renderer.

### 2.2 Placement determinism

A cell's contents are a pure function of `(mapSeed, rulesVersion, WRAPPED cell index)` and
the terrain heightfield. No `Math.random`, no time, no camera.

Keying on the **wrapped** index is what makes placement tile with the terrain. DF2 terrain
repeats every 2048 m and chunk geometry is already cached by wrapped index
(`docs/08` §6.2); vegetation follows, so the bush on the hill you can see is the same bush
on the same hill in the repeat behind it — and, less obviously, vegetation stays consistent
with the tree shadows already baked into the colormap (`docs/06` §6), which repeat for the
same reason.

Sites are **stratified** — a lattice at a fixed metre spacing, one jittered candidate per
subcell — rather than uniform-random over the cell. Uniform random clumps, and clumped cover
reads as unfair rather than as natural (`docs/00` pillar 5). A low-frequency macro-density
field on a lattice that divides the tile exactly gives clearings and thickets on top.

---

## 3. Rendering

### 3.1 Bucketing

`cell -> species -> InstancedMesh`. A cell takes **one LOD for all of its plants**, so
switching LOD is a geometry POINTER assignment and instance data never moves. That is the
one thing BatchedMesh genuinely offers, obtained without its per-draw cost on this backend.

The trade is LOD granularity: error at a switch boundary is up to half a cell diagonal,
which is why cell size is a sweep parameter rather than a constant anyone should trust.

Each bucket carries its own `boundingSphere` covering the cell footprint and the tallest
plant on it, so frustum culling operates per cell.

### 3.2 LOD selection

Distance to the cell centre, divided by a per-species `lodScale` and by the camera's zoom
factor, against `FOLIAGE_LOD_DISTANCES`, with 12% hysteresis and a per-cell hash stagger.

- `lodScale` is the memo's projected-screen-size argument factored into a per-species
  constant: a 6 m acacia must hold its detail further out than a 0.6 m scrub to switch at
  the same apparent size.
- The **zoom factor** is the same one the grass march uses (`docs/08` §6.4). A scope makes
  everything larger on screen without moving it, and a distance-only rule would drop detail
  exactly where a sniper is looking.
- The **stagger** breaks the ring of simultaneous pops that otherwise sweeps the world;
  hashing the cell index keeps it deterministic, so a cell always switches at the same range
  and the effect does not swim with the camera.

Transitions are hard, per the memo's own sequencing advice (hysteresis and stagger first,
dual-render dithered cross-fade only if popping is still unacceptable and only once it has
been measured).

### 3.3 The distance fade is a shrink, not an alpha ramp

At the window edge, plants scale toward their base. An alpha ramp under an alpha TEST does
not fade — it holds full opacity and then vanishes at the cutoff. Shrinking is
order-independent, needs no second draw, and keeps a plant fully opaque for as long as it is
visible at all.

### 3.4 Wind

Phase comes from world position and a **world clock** uniform, never `performance.now()` and
never a frame counter. Wind deforms the silhouette that conceals a player, so two clients
must agree on its phase; driving it from a shared time makes that possible later without
redesigning the material. Amplitude is deliberately small and the period long, so the
concealment envelope is effectively static — the memo's rule that wind must not open and
close large holes in cover. **Trunk vertices do not sway at all**, so the drawn trunk cannot
drift from the ballistic proxy.

---

## 4. The constraint that outranks looks

**Every LOD, and every card variant, preserves the plant's blocking fraction.**

This is `docs/08` §8 invariant 6 applied to vegetation: *the renderer must never conceal
less than the gameplay record says it does*. A distant LOD that quietly becomes more
transparent hands free vision of a covered target to whoever triggers it — and backing off
to trigger it costs nothing.

The metric is the estimated probability that a horizontal ray through the crown is blocked:
each card contributes its mean projected share of the crown's frontal rectangle
(`w × 2/π × h × cos(tilt) × alphaOccupancy`), and shares compose as independent occluders,
`1 − Π(1 − share)`. It saturates the way overlapping foliage does, instead of growing without
bound as cards are added.

- Geometric LODs drop cards and the survivors are **solved** to a shared target of 0.55.
- The impostor solves its **leaf density** instead: one camera-facing card already spans the
  frontal rectangle, so only its alpha occupancy is free to move.

Measured after the solve (`blockingFraction` is emitted per build and asserted in
`tests/foliage/foliage-geometry.test.ts`):

| species | variant | LOD0 | LOD1 | LOD2 | impostor |
|---|---|---|---|---|---|
| acacia | A | 20 tri / 0.55 | 14 / 0.55 | 12 / 0.55 | 2 / 0.55 |
| acacia | B | 34 / 0.55 | 22 / 0.55 | 14 / 0.55 | 2 / 0.55 |
| acacia | C | 30 / 0.55 | 18 / 0.55 | 12 / 0.55 | 2 / 0.55 |
| acacia | D | 58 / 0.55 | 34 / 0.55 | 22 / 0.55 | 2 / 0.55 |
| bush | A | 6 / 0.55 | 4 / 0.55 | 4 / 0.55 | 2 / 0.55 |
| bush | D | 44 / 0.55 | 24 / 0.55 | 14 / 0.55 | 2 / 0.55 |

Constant cover, ~10x spread in triangle count. That spread is the axis under test.

---

## 5. Alpha, and why the mip chain is a fairness feature

A box filter averages alpha. Under an alpha test that deletes geometry: a leaf covering 40%
of its texels averages toward 0.4, drops below the 0.5 cutoff, and is gone by mip 2 or 3.
The silhouette thins with distance — which is the same failure as a too-transparent distant
LOD, arriving by a different route.

`alphaMips.ts` rescales each level's alpha so the fraction of texels passing the cutoff
tracks level 0 (Castaño's method; still an open request against Khronos' own KTX tooling,
KTX-Software#486). Two decisions in it are load-bearing:

- **Colour is averaged weighted by alpha.** An unweighted average pulls the colour of
  transparent texels — usually black, because nothing authored them — into their neighbours,
  which is the dark fringe that makes cutout foliage read as dirty at range.
- **The scale search is biased UPWARD.** Coverage is a step function of the scale, so an
  exact match often does not exist, and once texels have merged into a near-uniform alpha
  the only reachable answers are "nothing passes" and "everything passes". A nearest-match
  search picks *nothing* for a sparse canopy — the fairness-violating direction. The search
  therefore prefers the smallest scale reaching **at least** the target.

Measured on the shipped leaf texture: occupancy 0.368 at level 0, and per-level coverage
`0.368 0.369 0.370 0.371 0.375 0.375 0.500 1.000` down to 1×1. It holds to within 0.007
across every level that can still resolve the leaves, then saturates on the last two — which
are only selected when the whole card is about one pixel.

The four alpha modes are runtime-switchable (`?foliagealpha=`) because the choice is
adapter-dependent and, for alpha hash, depends on whether this project ever gets stable
temporal AA. It has none today, so hash grain under motion may well be worse than hard
cutout edges. That is a measurement, not an argument.

---

## 6. Gameplay integration

### 6.1 Ballistics — built

`VegetationWorldQuery` walks the cell grid and tests analytic capped cylinders. It registers
as a *source* on `CompositeWorldQuery` rather than registering a collider per tree, which
follows the precedent the terrain already set: `CompositeWorldQuery` FORBIDS registering the
visual terrain and takes the canonical heightfield instead. Vegetation gets the same
treatment one layer up.

- Leaves stop nothing. Only trunks are in the query.
- The proxy comes from the species table and the instance record — never from the drawn
  mesh — so visual LOD, wind, distance fade and card variant cannot move where a bullet
  stops.
- Penetration thickness scales with the instance, so a big tree really is thicker.
- Object ids are `vegetation:<species>:<wrappedCellX>:<wrappedCellZ>:<index>` — deterministic
  and position-free, so two machines can name the same tree without exchanging geometry.

### 6.2 Concealment — deliberately NOT built

`docs/04`'s query does not exist yet at all. Adding half of it here would be scope creep,
and adding bushes to `grassHeightField` would be worse: the grass march reads that field as
a canopy envelope and would try to raymarch bushes as grass columns.

The hook is the record set. When the concealment query lands it should sample vegetation the
same way it samples the canopy — analytically, from `VegetationField`, using each species'
blocking fraction and crown extent — rather than from anything the renderer produced.

---

## 7. What still needs a machine with a GPU

Everything below has been *built*, and none of it has been *measured*, because this
environment has no GPU: three falls back to WebGL2 on SwiftShader and every millisecond it
reports is software-rasteriser CPU time (`docs/08` §10).

### 7.1 What was verified headlessly

`tools/foliage-rig/smoke.mjs`, at the standing bench vantage (5, 375), dpr 0.5, waiting for
the counts to settle:

| configuration | buckets | instances | scene draw calls |
|---|---|---|---|
| `foliage=0` (baseline) | — | — | 131 |
| cell 16 m | 994 | 2104 | 435 |
| cell 32 m | 398 | 2232 | 270 |
| cell 64 m | 140 | 2566 | 196 |
| cell 128 m | 75 | 4989 | 167 |

Read these as **draw-call counts only** — they are exact on any backend. Instance counts hold
roughly constant from 16 to 64 m, as they should now that density is per area; the rise at
128 m is the window rounding up to whole cells and covering 320 m instead of 192 m.

The headline: **vegetation roughly doubles the scene's draw calls at a 32 m cell** (131 →
270, so ~139 calls for 2232 plants inside 192 m). ~65% of submitted buckets are frustum
culled, so per-cell bounding spheres are earning their place. Whether 139 calls matters is a
GPU question, and it is the first thing to measure.

The graph compiles on the WebGL2 fallback with no console errors, which is the other thing
this rig is for.

**Do not read the fps in a screenshot from this environment as a foliage result.** A
settled ground-level frame here runs ~800–900 ms with vegetation *and* grass switched off,
and barely responds to resolution — 641 ms at dpr 1 against 864 ms at dpr 0.5 on separate
runs, which is noise, not a trend. It is CPU-bound software rasterisation, exactly as
`docs/08` §10 describes. Repeated runs of the same configuration produce frame times that
reorder freely (foliage 923 ms then 839 ms; baseline 798 ms then 856 ms) while the draw-call
and triangle counts reproduce *exactly*. That asymmetry is the whole reason only the counts
are quoted above.

The rig's own settle check had to be hardened to earn even those. Waiting on a stable
draw-call count alone is not enough when a frame takes most of a second: a 2 s poll sees
two or three frames, chunk building is budgeted per FRAME so it advances almost not at all
between polls, and two identical readings look settled while the world is still filling in.
One pass produced a run reporting 25 draw calls against another's 103 for the same scene.
It now requires draw calls *and* triangles to hold for four consecutive polls, and reports
`settled: false` rather than silently handing back a half-built world.

### 7.2 The sweep to run

Hold everything but one axis. Prone is the primary case, not standing — it is where the
grass march is already most expensive and where a player is inside the foliage.

1. **Baseline.** `?foliage=0` at each pose. Every number below is a delta against it.
2. **Cell size.** 16 / 32 / 64 / 128 m at fixed `foliageradius`. Expect draw calls to fall
   and wasted GPU work from coarse culling to rise; find the knee.
3. **Card variant.** A / B / C / D at a fixed cell size. All four conceal identically, so
   this isolates fragment cost against triangle cost. Variant A is the one to watch prone
   and edge-on: crossed planes collapse to strips from exactly the viewpoint this game uses.
4. **Alpha mode.** mask / a2c / hash / blend. Check image stability under camera motion as
   well as frame time; a2c and hash both trade differently there.
5. **Density.** `foliagedensity=` 0.5 / 1 / 2, to find where overdraw becomes the limiter.

Four camera cases each: standing outside vegetation, prone inside a bush, a fast horizontal
sweep, and a long-range view over many plants.

Escape the vsync cap before concluding anything — `8.3 / 16.7 / 33.3 ms` are cadences, not
measurements, and a cost that lives entirely inside one of them is invisible (`docs/09` §0).

### 7.3 Known open items

- **Foliage reads darker than the terrain.** The terrain is unlit pre-shaded colormap;
  foliage is PBR-lit by the scene's sun and hemisphere fill. Expect to dial the tints and
  light response — but do it on real hardware and against a reference, not in a software
  rasteriser, which is exactly the mistake `docs/08` §10 exists to prevent.
- **Shadows are not in the experiment.** The scene's directional light does not cast, so the
  memo's shadows-off / near-only / full axis is unavailable without enabling shadow maps
  globally — which would change every existing frame time. Deferred deliberately.
- **No impostor ring beyond the window.** Geometry is drawn to the window edge and nothing
  past it. A far ring of impostor-only cells at a coarser cell size is the obvious next step
  and is where the draw-call budget is most likely to be won.
- **Species do not share buckets.** A cell with all three species costs three draw calls.
  Merging species that share a material into one bucket per cell is possible but needs a
  shared geometry layout; measure first.
- **The cell-uniform LOD error is unquantified.** Half a cell diagonal at 32 m is ~23 m of
  LOD error at a boundary. Whether that is visible has not been checked.
- **BatchedMesh is worth re-checking** when mrdoob/three.js#30645 or a successor lands.

---

## 8. Try it

```sh
npm run dev
# then, in the browser:
#   ?foliage=1
#   ?foliage=1&foliagevariant=D&foliagealpha=a2c
#   ?bench=1&foliage=1&stance=prone&x=5&z=375&foliagecell=64
```

`?foliage=1` works on its own, without `?bench=1` — the variant comparison has to be run
from several poses and `?bench=1` pins the camera to the bench vantage (`docs/08` §11).
Counters are published to `window.__foliage` whenever the layer is on.
