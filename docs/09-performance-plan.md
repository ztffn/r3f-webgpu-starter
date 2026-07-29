# 09 — Grass performance plan

Goal: **60 fps at ground level on Green Mile**, at full resolution, without shortening
the grass draw distance. The premise is 1 km-plus sightlines and long-range
concealment, so trading range for frame rate is not on the table.

Status: baseline measured, no optimisation applied yet.

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
