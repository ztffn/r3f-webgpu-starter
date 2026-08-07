# Foliage, placed scenery and lit surfaces — plan v2

Supersedes `2026-08-07-lit-assets-and-foliage-plan.md`. That record was written before
anything had been measured on a GPU; this one is written after, and the measurements
changed the order of the work rather than merely confirming it.

Read §1 first if you are about to touch the foliage layer, §2 if you are about to measure
anything, and §5 before evaluating any third-party vegetation library — three of them were
assessed this session and all three were rejected for reasons that will still apply.

---

## 0. What is true now

Landed on `claude/foliage-rendering-research-jtr43e` (14 commits on main, PR #7):

| | |
|---|---|
| Vegetation runtime | Rebased onto main and building. Placement records, per-cell instanced buckets, cell-uniform LOD, analytic trunk ballistics |
| Post-lighting atmosphere | `atmosphere.litClass(Base)` — grade and fog AFTER lighting. Water and foliage adopt it |
| Vertex attributes | Packed. Ten buffers exceeded WebGPU's eight and NO plant had ever drawn on the primary backend |
| Frame-time distribution | `src/df2/frameStats.ts` — percentiles, cumulative histogram, hitch/stall/pause counters, GPU time |
| Pipeline warm-up | `compileAsync` over the real buckets at mount. **Measured: first-sweep hitches 8 to 0** |

Suite 375. Verified rendering on WebGPU: 2,097 plants across 407 cells, no pipeline failure.

## 1. The two defects that had made the layer un-judgeable

Both were invisible to reasoning and obvious to a measurement. Neither was in the design.

**Ten vertex buffers against WebGPU's eight.** Every foliage pipeline failed to create, so
no plant was ever drawn on WebGPU. It survived unnoticed because the environment the layer
was written in has no GPU and falls back to WebGL2 on SwiftShader, where the limit is
higher — the layer worked there and could not work here. This is also why every number in
the original vegetation design record is a draw-call count: nothing else could be trusted.

Independent confirmation that this is a standard trap rather than our quirk: the birdybird
port of an unrelated forest hit *"Vertex buffer count (9) exceeds the maximum"* and fixed it
the same way, by packing floats into one attribute.

**Foliage took three's linear scene fog while terrain faded to the sky.** Two fogs in one
scene. Fixed by the post-lighting term, whose own trap is recorded in `atmosphere.ts`: TSL
node types resolve during the build, so swizzling a node whose width is not yet known does
not narrow, `vec4()` receives five components, and the scene renders **black with no line of
code looking wrong**. `setupOutput` is the sanctioned hook; `material.outputNode` with the
`output` property node is not.

## 2. How to measure this project, and three ways it lies to you

`frameStats.ts` exists because a mean plus a per-window peak could not answer "did it
stutter while I looked around". The first reading it produced:

```
118 fps | 8.5 ms · peak 12 | p50 8.3 · p99 16.3 · max 1589 ms
18 hitch · 6 stall · 0 pause / 5591 frames
<8:3138  <17:2411  <33:24  <50:5  <100:3  <250:4  <1000:5  1s+:1
502 calls · 2883k tris · gpu 9.44 ms · WebGPU
```

A flawless mean and a 1.6-second frame in the same run. **Read p99, worst-since-load and
the hitch count before believing any mean on that panel.**

### 2.1 The camera sweep, which is the other half of the instrument

A histogram with no controlled stimulus measures nothing repeatable. Rotation is what
triggers first-draw cost, so a scripted sweep is required:

- Use a **non-scope scene** — `pointerLock` is only true for `?scene=scope`, and every other
  scene takes a drag path driven by client coordinates that synthetic pointer events can
  drive. `?scene=motor&debug=1&foliage=1` is the working form.
- Dispatch `pointerdown`, then one `pointermove` **per animation frame** (not per timer, or
  several rotations bunch into one frame), then `pointerup`.
- Read the hitch counter before and after. Repeat the same arc: a cost that vanishes on
  sweep two is first-draw setup, a cost that repeats is steady state.

### 2.2 Three traps that each produced a wrong conclusion this session

**A hidden tab does not produce slow numbers, it produces none.** Terrain chunks and foliage
buckets are budgeted per FRAME, and `requestAnimationFrame` barely fires for a hidden
document — so an unfocused Chrome window looks exactly like a hang. `document.hasFocus()`
was `true` while `document.visibilityState` was `"hidden"`. Check visibility, or better,
count rAF ticks over a second. This cost several wrong diagnoses, including one where I
cleared my own code using evidence that was worthless.

**The console reader returns oldest-first from an accumulating buffer.** A stale error from a
previous load reads exactly like a live one. Flush before every run. This produced a wrong
answer in both directions — a shader error reported as fixed when it was not, and later
suspected when it was.

**An unconditioned number is not a comparison.** Every performance figure encountered in
third-party material this session lacked a GPU model, a resolution or an object count. Our
own figures are equally worthless quoted without the vantage, the backend and the dpr.

## 3. What the hitch actually was

Measured with §2's protocol, same arc, same pacing:

| sweep | new hitches | frames |
|---|---|---|
| 1 | **+8** | 263 |
| 2 | 0 | 311 |
| 3 | 0 | 258 |
| 4 | 0 | 311 |

p50 flat at 8.4 ms throughout; p99 rose 13.5 → 20.2 on sweep one only. One-time per view,
not per frame. That rules out steady-state overdraw and identifies first-draw setup.

The warm-up therefore runs on the **real bucket meshes**: `_createObjectPipeline` uploads
buffers, creates the bind group and compiles the pipeline, and only the last is shared,
because three's geometry cache key is structural. Warming one representative bucket would
warm the cheap part. `compileAsync` also frustum-culls through the same `_projectObject` as
`render`, so `frustumCulled` must be off for the pass or it compiles only what is already
visible — the case that never hitches.

### 3.1 Result: it works

Same protocol, fresh load, cold GPU state (a navigation destroys the device and every
pipeline with it):

| | before warm-up | after warm-up |
|---|---|---|
| sweep 1, new hitches | **+8** | **0** |
| sweep 1, p99 | 13.5 → 20.2 ms | 13.6 ms, flat |
| sweeps 2-4 | 0 each | 0 each |
| p99 across all four | rose then settled | 13.4 - 13.7 ms |

The hitches did not disappear from the session — they **moved into load**, where the panel
reports 7 hitches and 2 stalls across the first 525 frames, the warm-up pass itself being
part of that. That is the right trade: a stutter while the world is assembling costs nothing,
a stutter while a player turns to track a target costs the shot.

Worth knowing for the next person: this confirms the cost was first-draw setup and that
`compileAsync` over the real meshes covers it. Had sweep one still hitched, the residue would
have been per-bucket buffer upload, and the fix would have been spreading first draws across
frames rather than precompiling.

## 4. Placed scenery: measured, and not a level-of-detail problem

| | placements | models | draw calls | triangles |
|---|---|---|---|---|
| warfields | 365 | 40 | 864 | 35k |
| killring | 281 | 10 | 902 | 28k |

Against ~131 for bare terrain, a mission is roughly seven times the draw calls for 35k
triangles — nothing. The converter emits one primitive per material (22 primitives / 22
materials, 18/18, 15/15) because 1999 artists used many texture-and-flag pairs on very
little geometry. **Reducing triangles saves nothing.** Instancing the repeated placements
takes warfields to 230 calls and killring to 53, since one wall segment is placed 195 times.

The legacy/new split and the shared prototype manifest from v1 stand unchanged; see that
record's §4. `tools/vegetation`'s schema is still most of the contract, and its validator
already refuses a pack with no licence or source URL — which turned out to matter (§5).

## 5. Third-party libraries: assessed and rejected, with reasons that persist

**`@three.ez/instanced-mesh`** (MIT, 442 stars, maintained). Per-instance frustum culling
via a dynamic BVH, per-instance uniforms, LOD, shadow LOD. **Does not support WebGPU.**
Issue #40, from the maintainer: *"It is currently only compatible with `WebGLRenderer`."*

**Its community WebGPU pull request** (#154). Substantial — real storage buffers, real TSL,
a working LOD path, a large Playwright suite. But conflicting with master, eight months
stale, its TSL `frustumCulling.ts` is a **pure stub** (imports commented out, returns
`null`), it leaves `console.log` in the per-frame LOD path, and decisively **it patches each
material's `positionNode`** to do index indirection — which collides head-on with ours, that
already owns that node for billboarding, wind and the distance shrink.

**`@three.ez/octahedron-imposter`** (MIT, v0.0.1, description "wip", untouched since
November). Works by string-replacing GLSL chunks through `material.onBeforeCompile` — a
mechanism that does not exist on the node-material path, so it is structurally WebGL, not
merely untested.

**Its assets are not takeable.** No credits file, no README mention, and a code search for
credit/attribution/sketchfab/CC-BY returns zero hits, while filenames read like a commercial
tree pack. An author cannot relicense art they do not own, and our own policy forbids
exactly this. Nothing baked ships anyway — the atlas is generated at runtime.

**The CodePen forest** is a showcase, and a cautionary one: its distance model shrinks leaf
cards to half area, deletes them past a cutoff, and **tints the trunk green so the eye does
not notice the canopy is gone** (the author's own words). For a sniping game that is exactly
backwards, and it is the clearest available example of why the blocking-fraction rule has to
be a constraint rather than a preference. Its shadows are real shadow maps but have **no
`customDepthMaterial`**, so the shadow pass ignores all of that LOD work and casts
undeformed geometry — cheap because the shadow disagrees with the silhouette.

### 5.1 What to take, all of it technique rather than dependency

- **Index indirection through a storage buffer** (from PR #154): one instanced mesh, a
  compact per-frame buffer of indices that should draw, matrices fetched by index in the
  shader. One draw call, arbitrary per-instance culling, LOD by which indices you write.
  This is the prerequisite that makes both a far ring and species-sharing affordable, and
  writing it in TSL ourselves means it composes with our `positionNode` instead of fighting
  it. Proven to work on WebGPU in 0.185 — that PR is the evidence.
- **Octahedral impostor parameters** (from their offline `exporter.ts`, which proves the bake
  works offline): hemi-octahedral, `spritesPerSide: 12` (144 views), `textureSize: 2048`,
  albedo plus a packed normal-and-depth atlas, alpha clamp ~0.4. Facts, not assets.
- **Unlit plus a hand-rolled sun term.** Both reference implementations light vegetation with
  a dot product and an ambient constant inside an unlit material, which is the same choice
  our terrain and grass already make. For our foliage it would leave the PBR path entirely
  and let it take the cheap `shade` on `colorNode` — fogging identically to terrain by
  construction rather than through the subclass.
- **Six-slot player parting** (from the grass pen): a uniform array of up to six positions
  with a radius falloff. Our blades part for the local player only; remote players currently
  leave grass undisturbed, which hides information the game should show. Fed from the
  authoritative snapshot it stays deterministic.
- **Out-of-NDC clamp rather than origin-collapse** when culling in a vertex shader: Apple's
  Metal driver does not reliably cull zero-area triangles at the clip-space origin.
- **A tight shadow box** if shadows ever land: the forest pen shadows a ±200 unit
  orthographic volume near the camera rather than sizing a frustum to the world.

## 6. Order

1. **Measure the warm-up** (§3). One foregrounded sweep. Cheap and it closes a loop.
2. **Unlit foliage A/B** (§5.1). Now judgeable, because the histogram shows whether p99
   moves rather than only the mean.
3. **Tighter per-cell bounding sphere** — compute the radius from the actual instances rather
   than the cell footprint plus tallest plant. Five minutes, culls more.
4. **Instance the mission props** (§4). Standalone, measured, independent of foliage.
5. **Index indirection in TSL** (§5.1) — the enabling piece.
6. **Octahedral impostor** on top of it, baked offline into `tools/vegetation`, replacing the
   yaw billboard as the furthest tier and enabling the far ring. **Audit its blocking
   fraction like every other tier**; the atlas is alpha-cut so the coverage-preserving mip
   work applies, and its clamp must be reconciled with our 0.5 cutoff.
7. **Then** the sweep protocol proper (cell size, card variant, alpha mode, density), which
   only means something once the far field exists.

**Worth doing before 6:** open agargaro's 200k-tree demo on this machine and measure it with
§2's discipline. Not to compare engines — that comparison is confounded four ways — but to
learn what an octahedral far field costs on *this* GPU at all, before spending a week on a
baker.

**Still deferred:** roughness and metalness from the surface-type bits, and its consequence
— the Lighting dials at wire indices 29–31 want a second pass when it lands, because they
are currently tuned against surfaces that are all `roughness 1, metalness 0`.

**Left alone deliberately:** shadows. The demo that made them look free gets them by letting
the shadow disagree with the geometry, and our own billboard would fail the opposite way —
in three's node system the depth pass DOES run our `positionNode`, so the card would face
the light and fade by the light's distance.

## 7. Open, and decided by data rather than argument

- **Authored vs grown vegetation collide.** Missions place plants as props: warfields has 33
  `kind: "foliage"` placements (26 cypress, 7 desert bush) plus 71 tumbleweeds it classes as
  decoration; killring has 8. The mission format already carries the field to resolve it —
  authored wins where it exists, the field fills the rest, keyed on `kind`.
- **Whether the layer earns its cost at all.** Still unanswered. The first GPU look put ~70–80
  extra draw calls and no mean-frame-time change against ~2,000 plants, but the camera
  respawns elsewhere on each reload and both runs sat near a 100 fps cadence, so a cost
  smaller than the gap to the next frame boundary is invisible.
- **Destructible props do not instance cleanly** — the intact-to-husk swap is per-instance
  visibility inside a shared bucket. Nothing is destructible today, so it constrains the
  prototype record rather than blocking anything.
- **Cell-uniform LOD error is unquantified** — half a cell diagonal is ~23 m at a 32 m cell.
