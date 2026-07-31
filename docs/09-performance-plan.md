# 09 — Grass performance plan

Goal: **60 fps at ground level on Green Mile**, at full resolution, without shortening
the grass draw distance. The premise is 1 km-plus sightlines and long-range
concealment, so trading range for frame rate is not on the table.

Status: **TARGET MET at the current test vantage.** 8.3 ms standing AND prone at Green Mile
(5, 375), dpr 1, mains power — which is the 120 Hz vsync cap, so the true cost is lower
still and unknown. Was 72.10 ms at the §1 baseline.

The wins, largest first: `GRASS_STEPS` was a stale constant running the march at 8x its
designed sample count (§3.1.0); bracket-and-bisect replacing the adaptive march (§3.1); the
baked jitter (§3.3); and the floor proxy narrowed to a per-pixel test (§3.1.1).

**Prone is no longer the worst case** — it now matches standing, where before it was 1.6x.
§3.2, horizon culling, has still not been attempted and is no longer needed to hit 60 fps
here. Keep it in reserve for the scoped case (§4), which remains entirely unmeasured.

Re-measure before quoting any older number in this document: most predate the §3.1.0 fix and
describe a march doing 8x the work.

**Every frame time in this document was measured while the pale-wash bug was live**
(`docs/07` §9). That bug was in the colour expression, not in the march, so it did not
change the sample count and the cost model in §2 still holds — but re-measure before
quoting a number as current.

---

## 1. Baseline

Machine: Apple GPU, WebGPU backend, 120 Hz display. Viewport 1597 × 914 CSS px.
Viewpoint: Green Mile, on foot, standing, world (0, 320), default heading and pitch.
Reproduce any row with:

```
http://localhost:3000/?bench=1&x=0&z=320&stance=stand&dpr=<dpr>&steps=<n>&grass=<0|1>
```

`?bench=1` fixes the vantage, makes the knobs settable, and publishes each perf
sample to `window.__perf` so numbers are read rather than eyeballed (`src/df2/bench.ts`).

| Grass | dpr | steps | Frame time | fps | Draw calls | Triangles |
|---|---|---|---|---|---|---|
| off | 1.0 | — | **8.35 ms** | 120 | 110 | 255k |
| on | 1.0 | 8 | **11.69 ms** | 86 | 132 | 976k |
| on | 1.0 | 16 | **17.23 ms** | 58 | 132 | 976k |
| on | 1.0 | 96 | **72.10 ms** | 14 | 132 | 976k |
| on | 0.5 | 8 | **8.33 ms** | 120 | 132 | 976k |
| on | 0.5 | 96 | **33.61 ms** | 30 | 132 | 976k |

**Read the 8.33 ms rows as "at or under the vsync cap", not as measurements.**
8.33 ms is exactly 1/120 s. Both of those rows are display-limited, so the true cost
of terrain alone, and of grass at half resolution with 8 steps, is unknown and lower.
Everything above 8.4 ms is a genuine reading.

## 2. What the numbers say

**Cost is linear in step count.** Least squares over the three dpr 1.0 rows:

```
frame_ms = 6.22 + 0.6862 × steps        (R² ≈ 1.000)
```

The fit reproduces all three points to within 0.03 ms. Two consequences:

- The whole problem is one number. 60 fps needs **15 effective steps per fragment**;
  120 fps would need 3, which is not happening.
- The 6.22 ms intercept is terrain, the grass shell's vertex and raster work, and
  everything else. It leaves about 10.5 ms for the march inside a 16.7 ms budget.

**The grass shell's geometry is not the problem.** At 8 steps, grass costs 3.3 ms
over the grass-off frame while adding 721k triangles and 22 draw calls. Pinning the
shell to LOD 0 (done to fix the floating-grass fringe) is therefore cheap. Do not
undo it for performance reasons.

**Cost is markedly sublinear in pixel count — this revises the plan.** Quartering the
pixels cut the frame from 72.10 ms to 33.61 ms, a factor of 2.15, where four times
fewer rays each taking coarser steps should have given four times or better. So
**half-resolution grass is worth roughly 2.3x on the march, not 4x.**

The likely cause is worth writing down, because it also constrains item 3 below: at
half resolution the pixel angle doubles, so the step doubles, so rays step *over*
more columns and miss. A miss runs the full step budget. Coarsening the step buys
fewer iterations per hit and more full-budget misses, and the two partly cancel.
Naively coarsening steps is therefore not a lever; bounding iterations is.

## 3. Plan, reordered by what was measured

### 3.0 Attempt 1 and what it cost — read before trying again

Bracket-and-bisect was implemented and measured **13.69 ms, 73.5 fps**, and it was
**visually wrong**. It bracketed the crossing using the smooth envelope and then
bisected against the jittered per-column top. Bisection requires the predicate to
differ at the two ends of the bracket; with two different predicates the bracket was
not valid, so the bisection collapsed onto the ray's entry point — which is the
shell, sitting at the canopy top by construction.

Every hit therefore resolved at the very tip of its column. The `hitFrac` debug view
was uniformly white. On screen the grass became a zero-thickness skin floating at
canopy height, with holes wherever the fine predicate happened to be false at both
ends. It looked like a speckled shell over the terrain, which is exactly what it was.

Making the coarse pass test the SAME jittered predicate fixes the picture — `hitFrac`
spreads properly across column heights — and costs **99.8 ms, worse than the 72.10 ms
baseline.** The predicate is nine `sin()` calls, and the coarse pass now pays it 12
times instead of the envelope's two texture fetches.

**The lesson for the ordering below:** the coarse pass cannot avoid the jittered
height, because the jitter IS the geometry being intersected. So §3.3, baking the
jitter into a texture, is not an optional per-step optimisation to do later. It is a
prerequisite for any scheme that samples coarsely. Do it first.

A second thing this exposed, independent of the march: at `GRASS_SCALE` the canopy
maxes at 1.2 m, which at any real viewing distance genuinely is a thin skin — about
9 px at 100 m, under 2 px at 500 m. Sliding it to 6 m gives obvious vertical extent
at no measurable cost, which suggests the world scale is wrong rather than the
shader. `HEIGHT_SCALE` and `METERS_PER_TEXEL` are still the uncalibrated placeholders
docs/01 §7 flags.

### 3.0.1 Debug affordance added while chasing the pale wash

The `?debug=1` panel gained views 4–9: `columns`, `faded`, the fog factor, the fog
input, the distance fade, and the fog colour uniform flat. 6–8 are **banded false
colour** (black / blue / green / yellow / red at 0.125 / 0.375 / 0.625 / 0.875), not
greyscale — a greyscale readout is not legible through a JPEG screenshot, and two
views that had to agree appeared to contradict until they were banded. Views ≥ 4 also
force the shell **opaque**, so the terrain cannot show through an alpha-tested miss and
be mistaken for a shader value.

These bisect the colour expression from a uniform instead of from an edit, which is
the difference between one build and one build per term. Reach for them before
hypothesising: the pale wash survived four patched hypotheses and fell to one
bisection.

### 3.1 Fixed-interval sampling (the whole target sits here)

Replace "small adaptive step until hit, capped at 96" with: compute the ray's entry
and exit analytically — entry at the shell fragment, exit where the ray crosses the
ground — then take a **fixed** N samples across that interval and refine the hit with
one or two bisections.

Why this and not step tuning:

- 16 fixed samples already measures at 17.23 ms, which is 58 fps. Adding two
  bisections lands near 19 ms. Getting under 16.7 ms then needs either N = 12–14 or
  a cheaper per-step cost (§3.3) — both within reach.
- Iteration count stops depending on view angle, so warp divergence goes away. The
  current tail, where one grazing lane holds a whole warp for 96 steps, is what makes
  the 0.686 ms/step slope as steep as it is.
- It fixes a correctness bug, not just cost. The step scales with distance from the
  eye, but the traversal length a ray needs scales with 1/sin(angle), and the two are
  independent. A near-field grazing ray gets a small step because it is near and
  needs tens of metres because it is shallow, so it exhausts the budget and drops
  grass. Sampling a computed interval makes reach correct at any angle by
  construction.

Risk: uniform sampling can step over a thin column where the current fine march
would catch it. Bisection recovers some of that. This needs a visual check against
the reference method in `docs/07`, not just a frame-time check.

### 3.1.0 The march was running 8x its designed sample count

`GRASS_STEPS` was 96. That was a **stale unit, not a tuning choice**: 96 was the budget for
the old adaptive march, which took many tiny steps until it hit something. The
bracket-and-bisect rewrite (§3.1) redefined `steps` as samples spread across a *computed
span*, and `GrassMaterial`'s own default is 12 — but the constant was never updated. So the
app ran 96 coarse samples plus 4 bisections where the design intends 16 samples total.

Measured at Green Mile (5, 375), standing, dpr 1:

| Coarse steps | Frame time | fps |
|---|---|---|
| 96 (shipped) | **19.6 ms** | 51 |
| 12 (design, now shipped) | **7.8 ms** | 127 |

7.8 ms is at the 120 Hz vsync cap, so the true cost is lower still. **The single largest
performance item found so far, and it was a leftover constant rather than an algorithm
problem.** No visible loss of grass density or silhouette at that vantage.

**Not yet checked:** prone, and along a ridge. The failure mode of too few coarse samples is
stepping OVER a thin column and missing it, which shows as sparse patches at grazing angles
rather than as uniform dimming — so standing at a moderate pitch is the *least* likely pose
to reveal it. Verify before treating 12 as settled.

**This invalidates the earlier rows in this document.** Everything measured before this
point ran 96 coarse samples, so the absolute numbers describe a march doing 8x the intended
work. The linear cost model in §2 still holds — that is what predicts this win — but
re-measure any absolute figure before quoting it.

### 3.1.2 Frame times move for reasons that are not the code — check power first

A 4x regression (7.8 ms -> 33.3 ms) was blamed on a shader edit and the edit was reverted to
isolate it. **Reverting changed nothing.** The cause was the laptop throttling on a low
battery; on mains it went straight back.

What made it diagnosable quickly, in the order that mattered:

| Test | Result | What it ruled out |
|---|---|---|
| revert the suspect edit | still 33.3 ms | the edit |
| `?steps=4` | still 33.3 ms | the march entirely |
| `?grass=0` | still 33.3 ms | **the whole grass system** |

Grass switched off being equally slow is what settles it — nothing in this document can
explain a frame that slow with no grass in it. The other tell is the number itself: 33.3 ms
is exactly 1/30 s, a vsync cadence rather than a workload. A real cost regression lands on
an arbitrary number; a throttle lands on 1/30, 1/40 or 1/60.

**Before attributing any frame-time change to an edit: confirm mains power, then measure
`?grass=0`.** Both are seconds of work and either can save an afternoon.

### 3.1.1 The floor proxy, and what it costs

Closing the grass volume's coverage hole (`docs/07` §9) added a second pass: the same
march against the un-lifted terrain surface, drawn only while the eye is inside the
canopy. Toggle it with `?grassfloor=0` to measure it against its own absence at the
same pose — a flag added because the only comparison otherwise available was
prone-with-floor against standing-without, which differs in the march too.

Rows are grouped by window, because the viewport sets the fragment count and rows from
different windows are not comparable. Neither group is comparable to §1's 132-call window.

**Window 1207 × 980, 93 base draw calls** — the sequence that located the cost:

| Pose | Floor pass | Frame time | Draw calls |
|---|---|---|---|
| standing | not drawn (eye above canopy) | **16.1 ms** | 93 |
| prone | `?grassfloor=0` | **17.4 ms** | 93 |
| prone | drawn wherever the eye is in canopy | **37.5 ms** | 111 |
| prone | + per-chunk narrowing | **26.5 ms** | 108 |
| standing | per-chunk narrowing WITHOUT the inside-canopy gate | **29.0 ms** | 108 |

**Window 1032 × 914, 93 base draw calls** — after the per-pixel cede test:

| Pose | Floor pass | Frame time | Draw calls |
|---|---|---|---|
| standing | not drawn | **16.4 ms** | 93 |
| prone | `?grassfloor=0` | **20.1 ms** | 93 |
| prone | shipped | **21.1 ms** | 108 |

Read these in order, because each killed an idea:

- **Prone with the floor off matches standing** (17.4 vs 16.1). The march is not
  stance-sensitive; every extra millisecond at prone was the floor pass.
- **The floor drawn everywhere costs 20 ms** — it more than doubled the frame. The pixels it
  covers are the ones previously skipped, so marching them is the fix, but 20 ms is not the
  price of that fix.
- **Per-chunk narrowing recovered 11 ms.** Chunks below the eye are already covered by the
  ceiling.
- **Dropping the inside-canopy gate for the per-chunk test alone cost 13 ms standing**
  (29.0 vs 16.1): every chunk with a peak above eye level then draws its floor.
  Geometrically more correct, not worth nearly doubling the standing frame for a failure
  case never shown to exist. Both conditions ship.
- **The per-pixel cede test is what actually fixed it: the floor pass now costs 1.0 ms**
  (21.1 vs 20.1), down from 20. Coarse gating was attacking the wrong axis — the floor's
  cost was fragments running a march the ceiling had already answered, and the only place
  that can be decided is per pixel.

What remains is **3.7 ms of prone-versus-standing that is the march itself** (20.1 vs 16.4
with the floor off both times): a low eye means grazing rays and near columns. That is
intrinsic to the viewpoint, not a bug, and it is what §3.2 attacks — at prone almost
nothing past the first ridge is visible, and horizon culling drops chunks from both passes
at once.

### 3.2 Horizon culling of grass chunks

At 1.7 m eye height almost nothing beyond the first ridge is visible, yet grass is
drawn and marched across the full 1100 m radius. Because `depthNode` disables
early-Z, every occluded fragment runs its complete march before losing the depth
test — and early-Z cannot be recovered, because WebGPU exposes no conservative-depth
declaration.

So do it on the CPU: for each grass chunk, ray-march the heightfield from the eye
toward the chunk and compare the ridge line against the sightline to the chunk's
maximum height. Skip chunks that are hidden.

This is the item that respects the 1 km requirement exactly — full detail where you
can see, nothing paid for grass behind a hill. It removes rays wholesale rather than
making them cheaper, so it multiplies with §3.1. Expect a large factor at eye height
and nothing at altitude, which is the right trade for this goal.

### 3.3 Per-step cost: bake the jitter, pack the fetches

Inside the loop, `clump()` is nine `sin()` calls recomputing a per-cell constant, plus
two dependent texture fetches. Reducing the 0.686 ms/step slope directly buys back
step budget for quality in §3.1.

- Bake jitter to a texture. Not at cell resolution: at 0.03 m cells and the 120 m
  hash period that is a 4000² texture, and shrinking it reintroduces the visible
  tiling that period was chosen to remove. Use a coarser jitter grid, around 0.12 m —
  striation *width* comes from the cell grid, only height variation comes from the
  jitter — or sample two small textures at coprime scales.
- Pack ground elevation and canopy height into one RG texture: two fetches become one.
- Sample at explicit level zero. Both fetches currently use implicit derivatives
  inside data-dependent control flow, which forces the compiler to carry derivative
  state through the loop.

### 3.4 Half-resolution grass — demoted

Measured at 2.3x on the march, not the 4x predicted, and it brings depth-aware
compositing complexity that risks fringing on exactly the silhouette this system
exists to render. Hold until §3.1–§3.3 are measured; take it only if still short.

### 3.5 Maximum mipmap for empty-space skipping — optional

A max-of-(ground + canopy) mip pyramid lets rays leap bare ground, which is the
standard height-field answer and attacks the miss case. Its value drops sharply once
§3.1 bounds iterations, since the unbounded miss is what it was going to fix. Keep it
in reserve.

## 4. Second target, not yet measured

The concealment mechanic is defined scoped, at 800 m. Unaided at that range a 2 m
target is about 2 px tall and 1 m of grass is about 1 px, so unaided long-range
concealment is barely a visual question; through a 10x scope the target is 20 px and
the grass is 10, and it is the only question that matters.

The march deliberately gets *finer* as the field of view narrows, so a 10x scope makes
the pixel angle ten times smaller and, under the current scheme, the step ten times
smaller. No scope is implemented, so this is entirely unmeasured. **60 fps unaided
does not imply 60 fps scoped.** §3.1 is the mitigation: a fixed sample count over a
computed interval does not blow up when the field of view narrows, because the
interval is a property of the geometry, not of the projection.
