# Terrain & Grass Rendering Design

## 1. Design intent

Reproduce two properties of DF2's original terrain/grass system that later mesh-based
approaches (including DF2's own successor, Land Warrior) lost:

1. **Visual density that does not thin with distance.** Grass must not visibly sparsen or
   "go naked" as draw distance increases.
2. **A prone player can be concealed in grass at ranges up to ~800m**, and this must be a
   reliable, cheap, gameplay-queryable property — not just a rendering side-effect.

Both properties trace back to a single fact about how the original engine worked, covered
in §2. Everything else in this document follows from that fact.

## 2. How the original achieved it — full technical analysis

DF2 ran NovaLogic's **Voxel Space 32** engine. Despite the "voxel" name, this is not a
volumetric/sparse-voxel renderer — it is a **heightfield + colormap raycaster**. Per
screen column (1 pixel wide), the renderer marches outward in world space, samples the
heightfield at each step, projects the sampled height to a screen-space Y coordinate, and
paints a **continuous vertical span** of color from the previous highest painted Y to the
new one (a painter's-algorithm silhouette fill, occluding as it goes). This is the entire
rendering primitive — there is no polygon, no discrete object, just a per-column height/
color lookup and a fill.

"Stretched voxels" — the DF2-specific feature that enabled tall-grass concealment — extended
this by adding extra height to a sampled point (amount driven by the detail map) before
projecting it to screen space, using color from the detail elevation/color strip for the
added span.

**The critical consequence:** this fill has a completely different cost/scaling
relationship than any primitive-based (polygon, billboard, or GPU-instanced blade)
approach:

- **Primitive-based rendering** (billboards, instanced blade meshes, even modern
  compute-driven pipelines like Sucker Punch's *Ghost of Tsushima* grass) represents grass
  as a finite, countable set of objects. Every performance strategy for this class of
  system — distance culling, frustum culling, LOD blade simplification, blade-count
  thinning at LOD boundaries — exists to manage a **primitive budget**, and works by
  *reducing actual coverage* and disguising the reduction (color-matching distant terrain
  to grass-top color, gradual thinning rather than popping, etc). This is true even of the
  best production-proven implementations: GoT's own GDC talk describes deliberately
  dropping 3 of every 4 blades approaching LOD tile boundaries. **Sparse-by-construction,
  with disguise layered on top**, is the ceiling of this entire technique family, no matter
  the scale (Three.js/WebGPU compute demos exist rendering 1M+ blades in-browser as of
  2026 — the ceiling moved, the shape of the problem didn't).

- **Voxel Space's per-column fill** is **dense by construction**. There is no concept of a
  "gap between blades" because there are no blades — every screen column, at native screen
  resolution, independently samples the heightfield and paints a value. Coverage is
  mathematically guaranteed to be 100% within the grass-flagged region, at every distance,
  forever. Cost scales with **screen resolution × raymarch step count**, not with an
  authored/instanced object count.

This is why DF2's grass reads as denser than modern blade systems at comparable or even
much lower actual performance budgets: it was never solving a coverage problem, because
its rendering primitive cannot produce gaps.

## 3. The modern equivalent already exists: relief mapping / POM

Per-fragment raymarching of a view ray through a heightfield stored in a texture is a
well-established real-time graphics technique, in continuous use since 2000:

- Relief Texture Mapping (Oliveira, Bishop, McAllister — SIGGRAPH 2000)
- Parallax Mapping (Kaneko et al., 2001)
- Parallax Occlusion Mapping / Steep Parallax Mapping (Brawley & Tatarchuk, 2004)
- Relaxed Cone Stepping / Cone-Step Mapping (later refinements for fewer raymarch steps)

These techniques exist to fake surface depth (bumps, grooves, brick relief) on flat
geometry without adding polygons, by raymarching a heightmap texture per-fragment.
Applying the identical machinery to a **"grass-top-height" channel** instead of a
brick/rock displacement channel produces, mechanically, the same class of result Voxel
Space achieved: a continuous, per-pixel, resolution-scaling fill with a bounded,
predictable, primitive-count-independent cost. This is the direct modern successor to
stretched voxels — not a metaphorical one, an actually equivalent computation moved from
"per raster column, CPU, 1999" to "per fragment, GPU shader, 2026."

## 4. Chosen architecture: two-layer hybrid

Neither technique alone is correct. Relief-mapped fill cannot bend under footsteps or show
individual blade silhouette/parallax up close (the eye can tell continuous shaded
"grass-texture" from real 3D geometry at close range — this was true in 1999 too, DF2's
own grass looked flat/textured up close). GPU-compute blade instancing gives the tactile,
interactive, close-range detail but cannot economically hold 100% coverage to the horizon.
Use both, each doing the job it's actually good at:

### 4.1 Primary layer — relief-mapped grass slab (mid-to-far field, ~15m to draw distance)

> ### ⚠ AS BUILT (July 2026) — read before changing `GrassMaterial.ts`
>
> The shipped shader follows this section's *principle* — a bounded per-fragment raymarch
> against a canopy height field — but five of its specifics turned out to be wrong once
> measured against the reference screenshots and the canonical Voxel Space source. The list
> below is what the code does and why; the contract is `08-...md` §6.4, the evidence is
> `07-...md` §§1, 5, 6.
>
> | This section says | As built | Why it changed |
> |---|---|---|
> | march *up* from terrain height to `terrain + grass-top` | render a **shell** (terrain lifted to the local canopy top) and march **down**; when the camera is *inside* the canopy, march from the **camera** instead of the fragment | marching from the fragment renders no near-field grass at all when you are standing in it — which is the entire mechanic |
> | "fixed, small step count (8–16 steps)" | **96 steps**, `step = max(cellSize, t · pixelAngle)` | a fixed step cannot serve both a 0.06 m near column and an 800 m sightline. The step is derived from the camera's angular resolution, so a **scope** narrowing FOV automatically tightens the march — sub-pixel-ness depends on FOV, not range |
> | colour from the **detail colour strip** (`_cm`) | colour from the **colormap**, sampled at the hit column's texel centre, one colour smeared up the whole column | the canonical implementation takes `map.color[mapoffset]` — a NEAREST colormap lookup — and paints the whole vertical span in it. Sampling per-step reads as soft modern grass, not DF2 grass (`07` §1.1, §6) |
> | bound cost with a depth/stencil pre-pass or grass-mask lookup | grass shell meshes are simply **not drawn** beyond `GRASS_FADE_END`; the shell collapses onto the terrain where no grass grows | cheaper, and needs no extra pass. The local-canopy shell lift does the masking for free |
> | *(not mentioned)* | the material **writes its own depth** at the raymarch hit (`material.depthNode`) | without it, anything standing *in* the grass depth-tests against a shell floating a canopy-height above ground and pops in front of it. **This is the real integration hurdle for GPU Voxel Space ports — not raw speed** |
>
> Also as built and not in the original plan: the material is **unlit** (the colormap is
> pre-shaded, so PBR double-shades it), alpha-tested rather than blended, and `DoubleSide`
> with **no** `normalNode` override.
>
> Still true and still the point: coverage is 100% by construction and structurally cannot
> thin with distance (§6). Still open: the grass is measurably flatter than the reference —
> `|dx|` ≈ 1.6 vs 2.23, vertical autocorrelation 0.42 vs 0.82 (`07` §7).

- A bounded-height fragment-shader raymarch: for each fragment covering grass-flagged
  terrain, march a ray from terrain-surface-height up to
  `terrain-height + grass-top-height(x,z)`, where `grass-top-height` is sampled from a
  texture derived from the extracted detail-map + detail-elevation-strip data (§2 of the
  asset-format spec).
- Fixed, small step count (8–16 steps is a reasonable starting budget; cone-step/relaxed-
  cone-stepping variants can reduce this further if profiling demands it), early-exit on
  hit.
- Bound the fragment cost to actual grass-covered screen area via a depth/stencil
  pre-pass or a cheap grass-mask texture lookup, so non-grass terrain pays nothing extra.
- No compute shader dependency — this is pure fragment-shader work, meaning it runs
  identically well on the WebGL2 fallback path as on WebGPU. This is a meaningful
  practical advantage: **the primary density layer does not require the ~95%-coverage
  WebGPU path to look right** — only the near-field compute blades (§4.2) do, and those
  gracefully degrade to shell-texturing or reduced instance counts on WebGL2.
- Color/shading sourced from the detail color texture strip; wind can be applied as a
  small per-fragment horizontal offset to the raymarch origin, driven by scrolling noise
  (cheap, no geometry to animate).
- This layer alone is responsible for the "more grass than that" density property and for
  never visibly thinning with distance — it structurally cannot thin, by the argument in
  §2–3.

### 4.2 Secondary layer — GPU-compute blade instancing (near field, ~0–15m)

> **⬜ Not started.** Nothing below exists in code. Note also `07-...md` §4's finding: the
> original look has *no* blade silhouettes at all, so this layer is a deliberate
> **modernisation, not a fidelity requirement** — it should be optional and toggleable so it
> can be A/B'd against the authentic look. Do not treat it as blocking Phase 2.
>
> **Read §4.4 before starting.** It is the implementation brief, written against a working
> relief layer, and it revises the priority above: the near field is now a measured weakness
> and a gameplay requirement rather than optional polish.

Adopt the *Ghost of Tsushima* production pipeline as reference, adapted to Three.js
WebGPURenderer + TSL compute:

- Compute-shader blade placement, sourced from the same density/elevation data as §4.1
  for consistency.
- Layered culling before any geometry is built, cheapest test first: distance cull →
  frustum cull → type cull (non-grass detail-map zone) → height cull (zero-density texel)
  → occlusion cull (optional, marginal gain per GoT's own findings, add only if profiling
  justifies it).
- LOD blade complexity rather than blade-count thinning where possible within this
  near-field band: full curvature near the player, simplified vertex count approaching the
  crossfade boundary.
- Wind: vertex-shader sine displacement driven by scrolling noise (same noise source as
  §4.1 for visual continuity across the crossfade).
- Interactivity: bend/displace blades near the player/vehicle position (read player world
  position as a compute-shader uniform, apply local displacement falloff).
- **WebGL2 fallback:** reduce instance count substantially and/or fall back toward
  shell-texturing (concentric offset mesh layers with alpha-masked height cutoff) for this
  near-field band only — the far-field columnar-march layer is unaffected either way, and
  is confirmed to run on the WebGL2 fallback.

### 4.3 Crossfade

> **⬜ Not started** — there is only one grass layer today, so there is nothing to cross-fade
> between. The shipped shader does fade *columns into the colormap* with distance, which is a
> different mechanism (`08-...md` §6.4).

Blend the two layers over a distance band (e.g. 10–20m) so the transition is not visible —
either a simple alpha crossfade or, more robustly, thinning §4.2's blade density to zero
across the band while §4.1 fades in, matching the density-preserving trick GoT uses at its
own internal LOD boundaries.

### 4.4 Implementation brief for §4.2 — written 2026-08-01, before any code

§4.2 says *what* to build. This says what we now know that changes *how*, and it is written
against a working relief layer rather than a blank page.

#### Why it is worth building now, which is not the reason §4.2 gave

§4.2 files this as a modernisation, optional, not blocking. Two things have changed that.

**The near field is the relief march's structural weak spot, and it is measured.** A column is
`GRASS_CELL` = 0.03 m in WORLD space, so it subtends ~22 px at 1.2 m and ~90 px at 0.3 m. One
flat colour per column is deliberate and correct — it is what produces striations — but at that
size it reads as tiling. DF2 never hit this because it drew one column per SCREEN column; its
columns were a pixel wide by construction. No amount of march tuning fixes a world-fixed cell
size (`08` §9, near-field blockiness).

**And it is now a gameplay requirement, not a polish item.** The mechanic is graded concealment
— lying in tall grass with your head positioned to see out through a gap. That is decided in the
first two metres of the ray, which is exactly where the relief layer is coarsest.

#### The one hard constraint: this is a THIRD representation of the canopy

Alongside the relief march and the analytic concealment query. **Blade placement, height and
clumping must be DERIVED from the same `grassMap` canopy field and the same `jitterMap`, not
re-derived from a fresh noise function.** If a blade stands where the march says there is no
column, or at a different height, the layers disagree — and the whole of the 2026-07-31 session
was spent on two representations of one field disagreeing by half a texel (`08` §11, "three
surfaces where there should be one"). Concealment stays authoritative on the march and the CPU
field; blades are visual only and must never be sampled for gameplay.

#### Two reference implementations, and what each settles

| | [penev.tech/labs/grass](https://penev.tech/labs/grass) | [aleksandargjoreski.dev](https://aleksandargjoreski.dev/blog/growing-my-grass-shader/) |
|---|---|---|
| Primitive | curved 3-edge blade, real geometry | camera-facing sprite, single-faced |
| Count | ~200k `InstancedMesh` | 1.18M, one draw call |
| Detail falloff | device-tier instance scaling | **stochastic thinning** — full to ~10 units, 10% by 60 |
| Culling | — | GPU-side frustum cull by pushing culled vertices out of view |
| Interaction | **trail render target**, WebGPU compute variant with spring physics | — |

The load-bearing lesson is Gjoreski's framing: **the bottleneck is how many times you shade the
same pixel, not triangle count.** Overlapping thin geometry is overdraw. That is precisely the
bug that cost 33.3 ms against 8.5 ms this session — one pixel marching several times — so it is
the right lens, not a generic optimisation tip. Corollaries worth taking on faith: single-faced
sprites halve fragment work outright, and `discard` is wasteful because the work is already done
by the time it runs.

Penev's trail texture is the piece with gameplay value rather than only visual value: crawling
should flatten grass behind you, which is both a tell for other players and a readable
consequence of the concealment mechanic. Blades sample displacement by world XZ from a small
render target (512² is enough). Defer it, but do not design it out.

#### Perf: state the structural win, do not assume blades are cheap

The saving is **not** that blades are cheap. It is that they let the relief layer stop doing
near-field work entirely — and the near field is where the march is most expensive, because
prone it is the whole screen. That is a real, bankable saving.

Against it: prone you are inside the canopy, so blades fill the frame, which is exactly the
overdraw case Gjoreski spends his effort on. His 120 fps is a flat patch with no terrain march
underneath; we would have both layers plus terrain. **Measure it, do not claim it.**

#### Measurement protocol, because the traps here are known

- Bench with `?bench=1` (forces full canopy) and compare **prone** as the primary case, not
  standing — prone is where this layer earns its place.
- `8.3 ms` is the 120 Hz cap and `16.7`/`33.3 ms` are the 60/30 Hz steps. A frame anywhere
  between 16.7 and 33.3 reports as 33.3, so halving resolution can look like a no-op. Escape the
  cap with `?dpr=0.25` or `?steps=1` before concluding where a cost lives (`09` §0).
- Give the layer its own `?` toggle from the start, so it can be measured against its own
  absence at the same pose. That is why `?grasscap=` exists.

#### Open decisions, listed so they are made deliberately

1. **Sprite or real blade geometry.** Sprites are cheaper and Gjoreski's argument is strong.
   But DF2's look has *no* blade silhouettes at all (`07` §4), so this layer is already a
   departure — decide how far to take it against `00`'s recognisability test before building.
2. **Radius and handover.** §4.2 proposes 0–15 m. The relief layer's columns become
   sub-pixel around 28 m, which is a more principled boundary. Stochastic thinning across the
   band is likely better than an alpha crossfade, and matches the existing distance fade's
   intent.
3. **Whether blades replace the march in their radius or overlay it.** Replacing is cheaper and
   avoids double-shading; overlaying is safer for coverage. Note the march must still run for
   concealment-relevant depth even where blades draw.
4. **WebGL2 fallback** (§4.2 already flags this). The relief layer is confirmed on WebGL2; this
   layer needs a reduced path or none.

## 5. Terrain base mesh (context for the grass layers above)

- Chunked, LOD'd heightmap mesh (standard geomipmapping or clipmap scheme), built from the
  extracted heightmap, textured with the extracted colormap.
- **As built, plus one thing this section did not anticipate:** the mesh **tiles
  infinitely**. DF2 terrain has no edges (`06-...md` §10), so chunks are not a fixed grid
  over one map but a camera-centred moving window, with geometry cached by *wrapped* chunk
  index. This is why the CPU heightfield stores exactly `period × period` samples with no
  duplicated edge row, and why every terrain texture uses `RepeatWrapping`. Details and the
  invariants it imposes: `08-...md` §§4, 6.2.
- **On repetition (decided, July 2026):** a 2048 m tile recurring forever could read as
  pattern rather than landscape, which would work against `00` Pillar 2. Accepted as
  low-risk. If it ever becomes visible, **fog is the lever** — tighten `FOG_FAR` so a player
  cannot see far enough to catch a repeat. Do not build machinery to defeat tiling
  pre-emptively.
- An optional literal Voxel Space raycast renderer, implemented as a full-screen
  fragment-shader raymarch against the heightmap texture, retained as a toggleable
  "authentic mode" for period-accurate horizon-warp/draw-distance behavior — not the
  primary renderer, since a rasterized mesh integrates far better with the two grass
  layers above, physics, and standard PBR lighting.

## 6. Why this specifically answers "DF2 had more grass than that"

Any pure blade-instancing approach — no matter how large the compute budget — is bounded
by the primitive-sparsity ceiling described in §2. The relief-mapped slab in §4.1 has no
such ceiling; its coverage is mathematically 100% by construction, identical in kind to
what the original stretched-voxel columns guaranteed. The compute-blade layer in §4.2 adds
tactile richness on top, in the band where it's actually visible to the eye, without ever
being asked to carry the far-field density job it structurally can't do as cheaply as a
raymarch can.

## 7. Open implementation questions

- Exact raymarch step count vs. visual quality/performance tradeoff — needs profiling once
  a prototype exists, likely device-tiered (desktop vs. mobile).
  **Still open, and no real numbers exist yet:** every frame time measured so far came from
  a GPU-less container running the WebGL2 fallback on SwiftShader, where ground-level frames
  take 300–1000 ms *with grass off*. Draw-call and triangle counts are trustworthy; frame
  times are not (`08-...md` §10). There is also an unconfirmed reading that the step count
  may cap the march's reach to ~6 m when the camera is inside the canopy (`08-...md` §9) —
  settle that before tuning anything.
- Whether cone-step/relaxed-cone-stepping preprocessing (build a max-height "cone" acceleration
  structure from the density texture) is worth the extra offline bake step to cut runtime
  step count — evaluate after a naive fixed-step version is profiled.
- Grass color/shading response to time-of-day/lighting — DF2's colormap baked in static
  lighting; a modern version should probably support dynamic lighting on both grass layers
  for a genuine visual upgrade, but must keep the two layers' shading models close enough
  that the crossfade in §4.3 is invisible.
