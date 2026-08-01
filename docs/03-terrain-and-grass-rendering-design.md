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
| Primitive | curved 3-edge blade (left/centre/right converging to the tip), real geometry, width tapered `w*(1-t)` per ring | camera-facing sprite, single-faced, 4 segments |
| Count | up to 200k `InstancedMesh`, 50k default | 1.18M over ~130×130 m — about **70 blades/m²** — one draw call, 8.2M tris at 120 fps on an M2 |
| Per-instance data | packed attribute: static bend angle, height scale, colour seed | bit-packed traits, compute-generated |
| Detail falloff | device tier only: mobile 35% capped at 20k, low-end GPU a further 45% | **stochastic thinning**, full to 10 units, 10% by 60 |
| Culling | — | GPU frustum cull by pushing culled vertices out of view, not `discard`; ~1/3 visible |
| Wind | vertex-stage 2-octave simplex, weighted by `uv.y^2.8` so the root is anchored, per-instance phase and speed, gust travels root-to-tip via a `uv.y` time lag. **Fixed +X direction** | noise-driven world-space offset; "the wind vector lives in the world, not the blade's local orientation" |
| Lighting | wrapped diffuse, subsurface, sheen + fresnel glint, sepia grade | `MeshBasicNodeMaterial`, unlit, AO only near the base |
| Interaction | **trail render target** at a fixed 512², WebGL dual-pass (decay + additive brush), WebGPU compute variant with rise-fast/fall-slow spring physics | — |

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

#### Recovered parameters from the shipped bundle

Read out of the deployed Nuxt chunk (`penev.tech/_nuxt/C3gbpMUr.js`, component `GrassCanvas`) —
the labs page itself does not render its source in a readable form. The write-up is published as
a tutorial with its snippets intended for reuse, so this is reference material to work from
directly rather than to tiptoe around.

It still has to be **ported, not pasted**, for a purely technical reason: his is raw GLSL, and
this project authors shaders in **TSL** so one graph serves both the WebGPU and WebGL2 backends
(`CLAUDE.md`). Keep the numbers below, rewrite the expression.

| | value / shape |
|---|---|
| Blade defaults | width 0.12 m, height 1.0 m — note that is ~4 `GRASS_CELL` columns wide and about our full canopy height, so blades are COARSER than columns, which is why they overlay rather than replace |
| Geometry | 3 verts per ring × (segments+1) rings, 4 tris per segment. Width tapers `w*(1-t)`; the centre vert is pushed to `z = w*0.5`, giving the V cross-section that reads as volume |
| Per-instance attribute | ONE `vec3`: `(staticBend, heightScale, signedSeed)`. The seed is reused for twist, curve power, wind speed, trail rotation and colour — one number, five jobs |
| Twist | `angle = seed * 2.5 * uv.y`, rotating the section about Y so the blade turns along its length |
| Static bend | `pow(uv.y, curvePower) * staticBend`, with `curvePower` per instance in [2.0, 3.5] |
| Wind noise | 2 octaves of simplex at `0.48 * uNoiseScale` and double that, weighted 0.8 / 0.2 |
| Wind time | `uTime * windSpeed(200) * 0.0006 * (1 + seed*0.15)` — per-instance speed so blades desync |
| Wind lag | `uv.y * 1.2 + staticBend * 0.5`, SUBTRACTED from time, so the gust travels root to tip |
| Root anchor | `windBend = wind * pow(uv.y, 2.8) * 1.4` |
| Trail masks | root `smoothstep(0, 0.15, uv.y)`, tip `pow(uv.y, 1.8)`, push ≤ 12.2, Y drop 0.3 × push |
| Colour | `mix(base, tip, smoothstep(0,1,uv.y))` then 15% desaturation; base `#051105`, tip `#88cc00` |

Three details that are not in his write-up and are worth taking:

1. **Arc-length compensation.** Every bend also does `y -= abs(bend) * 0.3`. Without it a bending
   blade visibly stretches, because rotating a vertical strip by displacing X alone lengthens it.
   Cheap, and its absence is the tell that grass is "rubbery".
2. **The gust travels.** Subtracting a `uv.y`-proportional lag from the noise time is what makes
   wind look like moving air rather than synchronised wobble. It costs one subtraction.
3. **Normals are synthesised, never derived from the geometry** — assembled analytically from the
   bend directions. We need none of this: unlit means no normal at all, which is a straight saving.

**The one place we must diverge: he displaces X only**, i.e. wind blows along world +X forever.
Ours has to displace along the XZ direction of `BallisticEnvironment.windVelocity`, or the
instrument lies — see the wind section below.

#### Reject Penev's shading wholesale — it is the one thing that would break the look

Everything in his fragment shader is built for a lit, stylised, standalone field: wrapped
diffuse, subsurface translucency, specular sheen, fresnel glint, a fresh-green-to-dry-brown
random palette, sepia grade and a contrast boost. **None of it applies here.** Our colormap is
PRE-SHADED — it already bakes lighting and shadow (`06` §6) — and every material in this
renderer is unlit `MeshBasicNodeMaterial` because the original applied no lighting at all.
Blades lit that way would match neither the terrain under them nor the relief columns beside
them. Gjoreski reaches the same place from the other direction and also ships
`MeshBasicNodeMaterial`; follow him, not Penev, on shading.

The random green-to-brown palette is doubly wrong: blade colour has to come FROM the colormap,
which is the whole point of following the vegetation. A private palette would fight the map.

Take from Penev: the tapered 3-edge geometry, the packed per-instance attribute, the
vertex-stage wind with an anchored root, the device-tier scaling, and the trail target.

#### The spec, settled 2026-08-01

Small and canopy-driven, NOT a full grass field. The relief march still draws the dense canopy
underneath; blades only add silhouette where columns are too wide to read (`08` §9).

- **A few thousand blades**, order 4,000, live on a slider. That is 12x smaller than Penev's
  default and ~300x smaller than Gjoreski, because neither of them had a march underneath doing
  the covering. Sparse-but-visible is the target; coverage is not.
- **Fewer and fewer with distance**, by stochastic thinning. This is not merely preferred, it is
  FORCED: opacity feeds an alpha test at 0.5, and the recorded lesson is that a crossfade through
  a binary test collapses into a hard ring (`GrassMaterial`, the fade note). Thinning is the only
  falloff a binary test can express.
- **Height, density and colour all follow the canopy field**, from the same textures the march
  reads:
  - *height* — `canopyBase(xz) * (mix(jitter, strandHash) * 0.62 + 0.38)`, literally
    `columnTopAt`'s `top`, so a blade stands exactly as tall as the columns around it;
  - *density* — the canopy value IS the existence probability, so the 11.2% of Green Mile with
    no canopy grows no blades and short canopy grows sparse ones;
  - *colour* — `colorMap` at the blade's own cell plus the same per-column tone hash and the same
    `GRASS_SHADE_BASE` base-to-tip ramp.

  One stable per-instance random tests against `p(distance) * canopyDensity`, so distance falloff
  and canopy density are the SAME test rather than two.

**Do the placement in the vertex stage, not on the CPU.** A fixed instance pool sits on a
camera-following wrapped grid; each instance samples `grassMap`/`jitterMap`/`heightMap` itself
and collapses to a degenerate triangle when rejected — Gjoreski's trick, and it costs no
fragments. The reason is not performance at these counts, it is agreement: sampling the same
textures the march samples makes the two layers agree BY CONSTRUCTION rather than by a CPU copy
that can drift. That is the third-representation constraint above, discharged structurally.

`heightMap` has a mip chain matched to the mesh LOD and needs the half-texel correction
(`08` §11). A blade that skips it floats or sinks exactly as the shell did.

#### Wind: the reason this earns its frame time

`BallisticEnvironment.windVelocity` already exists on the FPS side, defaults to 4 m/s, is
settable with `?windx`/`?windz`, and is AUTHORITATIVE — it drifts bullets. Bend blades to that
same world vector and grass stops being decoration: it becomes the instrument the player reads
to judge their windage correction, which at the Barrett's 800 m is the difference between a hit
and a miss. The scope already has manual windage to dial against it.

Penev's shape is right for this — noise-driven displacement weighted by height so the root stays
planted — but the DIRECTION and STRENGTH must come from the gameplay vector, not a free
parameter, or the instrument lies. One caveat to carry: wind is currently a single global vector,
so grass at your feet honestly reports the whole flight path. That stops being true the day wind
becomes positional.

#### Perf: what blades do and do not buy

They do NOT delete the camera cap, which was the hope. The cap sits 0.2 m from the eye and writes
depth from the march hit with early-Z disabled by `depthNode`, so no amount of geometry in front
can depth-reject it; and a level ray from inside the canopy still needs it beyond the blade
radius. What blades plausibly buy is a shorter `GRASS_INSIDE_SPAN` or a lower step count for the
cap. Measure that, do not assume it — the cap's own cost was invisible for a whole session
(`09` §0.1).

Triangles are not the constraint. 4,000 blades at ~20 triangles is 80k against terrain's measured
415k. The constraint is overdraw, prone, where blades fill the frame — the case Gjoreski spends
his whole effort on, and his 120 fps is a flat patch with no march or terrain underneath.

#### Measurement protocol, because the traps here are known

- Bench with `?bench=1` (forces full canopy) and compare **prone**, where the near field is the
  whole screen.
- `8.3 ms` is the 120 Hz cap and `16.7`/`33.3 ms` are the 60/30 Hz steps. A frame anywhere
  between 16.7 and 33.3 reports as 33.3, so halving resolution can look like a no-op. Escape the
  cap with `?dpr=2 &steps=` high, or `?dpr=0.25`, before concluding where a cost lives (`09` §0).
  This is not theoretical: it hid a 9.7 ms cost until it was deliberately unmasked.
- Give the layer its own `?` toggle in the FIRST commit, so it can be measured against its own
  absence at the same pose. That is why `?grasscap=` exists, and it is what made `09` §0.1
  possible.

#### Still open, and deliberately so

1. **How far the primitive goes.** Penev's 3-edge curved blade is affordable at a few thousand
   and avoids billboard swim, so "cheap" no longer forces a sprite. But DF2's look has *no* blade
   silhouettes at all (`07` §4). The middle path worth trying first is a TAPERED, near-flat,
   world-anchored blade: DF2's vertical columnar identity, plus a real edge against the sky.
   Settle it by looking, in the rig, against `00`'s recognisability test.
2. **Radius and handover.** §4.2 proposes 0–15 m; columns go sub-pixel around 28 m, which is the
   more principled boundary. At 4,000 blades, 8 m gives ~20/m² and 15 m gives ~6/m².
3. **Scoped targets as a second application.** At 800 m the march has already faded to flat
   colormap, so a scoped view shows bare ground where the field counts a target concealed — the
   remaining invariant-6 gap. A blade patch at the point of aim closes it, and 10x magnification
   means a small world patch buys a large angular payoff. Different justification, same system.
4. **Trail displacement.** Crawling should flatten grass behind you — a tell for other players
   and a readable consequence of the mechanic. Penev's 512² target and rise-fast/fall-slow spring
   are the recipe. Defer, but do not design it out.
5. **WebGL2 fallback** (§4.2 already flags this). The relief layer is confirmed on WebGL2; this
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
