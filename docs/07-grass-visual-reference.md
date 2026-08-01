# Grass — Visual Reference Analysis

Observations taken from in-game DF2 screenshots (`docs/df2_grass_1..5`). These are the
acceptance criteria for Phase 2: the grass system is "right" when it reproduces the
properties below, not when it merely looks like nice grass.

The rendering rationale is in `03-terrain-and-grass-rendering-design.md`; this document
pins down *what the target actually looks like*, which turns out to constrain the shader
more tightly than the design doc assumed.

---

## 1. What the screenshots show

### 1.1 Grass renders as VERTICAL STRIATIONS, not blades
The single most identifiable trait. In `df2_grass_3` and `df2_grass_4` the canopy is
visibly made of **thin vertical streaks** — one per heightmap column — each a smear of
colour with hard left/right edges. There is no blade geometry, no cross-quad billboard, no
rounded tip. This is the direct visual signature of the stretched-voxel column fill
(`03-...md` §2): each screen column samples the field once and paints a vertical span.

**Implication:** a relief/POM march that samples colour *per fragment along the view ray*
will look wrong — too soft, too volumetric. The march must keep **vertical colour
coherence**: colour is fetched from the column's **ground texel** and smeared up the
column, so every pixel of one grass column shares a base colour.

### 1.2 Coverage is total, and it does not thin with distance
No gaps anywhere in a grass zone, at any range — including the far hillsides in
`df2_grass_5`, which carry the same solid grass tone as the foreground. Confirms the
"dense by construction" argument in `03-...md` §2 and rules out any approach whose density
falls off with distance.

### 1.3 The canopy has a hard, irregular silhouette
In `df2_grass_3` the grass field ends against the hillside along a **crisp diagonal edge**,
and its top edge is ragged — per-column height variation, not a smooth blended surface.
Zone boundaries from the detail map are **sharp**, not feathered.

**Implication:** don't smooth/blur the grass-height field when baking `grassHeightField`;
preserve per-texel height variation, and let zone edges stay hard.

### 1.4 Per-column colour variation
Adjacent columns differ in green/olive tone, producing the characteristic vertical
"corduroy" texture. Sourced from the detail colour strip (`_cm`) indexed by the detail map,
sampled at the column base.

### 1.5 It occludes characters — the concealment mechanic, visible
In `df2_grass_3` the standing soldier's legs are **cut off mid-thigh** by the canopy; in
`df2_grass_4` the player is looking through foreground grass at a target 251 m away, with
the canopy breaking up the sightline. This is exactly the property
`04-concealment-system-design.md` formalises: the same field that draws must decide
visibility.

### 1.6 Bare terrain is smooth and colormap-driven
`df2_grass_1`/`df2_grass_2` show non-grass terrain as soft, low-frequency shading carried
entirely by the colormap — no visible mesh faceting, no tiling detail texture fighting it.
Our current Phase 1.5 render already matches this reasonably well.

---

## 2. Scale anchors (useful for calibration)

The screenshots carry an in-game HUD with **RANGE** and **ELEVATION** readouts, which is
the best scale evidence available without the base game:

| Shot | HUD reading | Use |
| --- | --- | --- |
| `df2_grass_5` | RANGE 85 m, ELEVATION 89 m | mid-range hill spacing |
| `df2_grass_4` | RANGE 75 m, DISTANCE 251 m to the marked structure | foreground-to-objective distance |
| `df2_grass_2` | RANGE 19 m, ELEVATION 5 m | near-field valley floor |

**Grass height vs. character:** in `df2_grass_3` the canopy reaches roughly the soldier's
waist; in `df2_grass_5` a little above the knee. Against a ~1.8 m figure that puts typical
tall grass at **≈0.8–1.1 m**, which is consistent with the concealment table in
`04-...md` §4.2 (prone ≈0.3 m hidden, crouch ≈0.9 m marginal, standing ≈1.6 m exposed).

These give us a way to calibrate `HEIGHT_SCALE` / `METERS_PER_TEXEL` *indirectly*: pick
values where a 1 m grass canopy conceals prone and not standing, and where hills read at
the ranges above.

---

## 3. Acceptance criteria for Phase 2

A grass implementation honours the original when all of these hold. **Status as of July 2026
— 3 of 6 met, 1 not met, 2 unverifiable on current data/hardware.** Evidence in §7 and §8; do
not tick anything here without a measurement behind it.

| | Criterion | Status |
|---|---|---|
| 1 | **Vertical coherence** — grass reads as vertical columns, one colour per column base | ❌ **not met.** Vertical autocorrelation **0.42 vs 0.82** reference; reads as isotropic speckle, not streaks. Cause understood and geometric — see §7 |
| 2 | **No thinning** — coverage visually identical at 10 m and at 800 m | ✅ met by construction. Per-fragment march + colormap handover; it structurally cannot thin. Caveat: the prone/inside-canopy path is separately broken (§7 next-step 1, `08-...md` §9) |
| 3 | **Hard zone edges** — grass stops abruptly where the detail map says it stops | ⬜ **not verifiable on the shipped map** — Green Mile's canopy is a colormap-greenness stand-in, so its edges are not the detail map's edges. **But it is testable today on another map:** egypt, R66, blizzard and vul001 ship their own `detail_elev` strips and load as `grassSource: "real"` (`06-...md` §7). Prepare one and this criterion can be closed without waiting for `dfdg1_dm` |
| 4 | **Ragged canopy top** — per-column height variation visible in silhouette | ✅ met — clumped multi-scale jitter (§1.3). Arguably *over*-met: tops speckle where the original's are smoother (§7 next-step 2) |
| 5 | **Occludes a standing figure to roughly the waist** at default scale | ✅ measured — a 2 m capsule at 50 m in 0.97 m canopy loses its lower half; standing 525 px scoped vs prone 0 px (§8). Caveat: "default scale" is still uncalibrated (`08-...md` §7) |
| 6 | **Cost independent of distance/coverage** — no per-blade budget | ✅ met by construction — per-fragment, no primitives. ⚠️ **unverified on real hardware**: no trustworthy GPU numbers exist (`08-...md` §10) |

## 4. Where this modifies the Phase 2 plan

`03-...md` §4 specifies a two-layer hybrid (relief-mapped far field + compute-instanced
near blades). The references sharpen two points:

- The **relief layer is even more central than assumed** — the original look has *no*
  blade silhouettes at all, so the far layer alone reproduces the DF2 appearance. The
  near-field blade layer is a deliberate *modernisation*, not a fidelity requirement, and
  should be optional/toggleable so we can A/B it against the authentic look.
- The relief march must be authored for **columnar** output (§1.1) rather than generic
  parallax-occlusion depth, otherwise it will read as modern grass rather than DF2 grass.

An "authentic mode" toggle that renders columns only — no near blades, no soft blending —
is therefore worth building *first*, since it is both the fidelity target and the simpler
shader.

---

## 5. Measurement methodology (added during Phase 2 work)

Impressions are not good enough for this — "looks grassy" passed several builds
that were measurably wrong. Two statistics, computed on a crop of canopy:

- **`|dx|` / `|dy|`** — mean absolute difference between horizontally and
  vertically adjacent pixels. Columnar grass changes colour ACROSS columns much
  more than UP them.
- **Autocorrelation at lag 8** in each axis — how far structure persists.

Scores on the references (`df2_grass_3` grass field):

| metric | reference |
| --- | --- |
| `h/v` ratio | **1.60** |
| `|dx|` | **2.80** |
| `|dy|` | **1.75** |
| hAC@8 | +0.79 |
| vAC@8 | +0.82 |

**Both numbers matter.** An early build scored h/v 1.46 and looked like a match
until the crop was inspected: it was bare terrain, where both derivatives are
near zero and the ratio is meaningless. Always check `|dx|` is in range too.

A headless rig (single tile, fixed vantage, one frame, canvas dumped and scored)
makes a config testable in ~1.5 s, versus minutes through the full app.

## 6. What the canonical implementation settles

Reading `s-macke/VoxelSpace` (the reverse-engineered Comanche renderer) resolved
several guesses:

```js
var mapoffset = ((Math.floor(ply) & mapwidthperiod) << map.shift)
              + (Math.floor(plx) & mapheightperiod);
var heightonscreen = (camera.height - map.altitude[mapoffset]) * invz + camera.horizon;
DrawVerticalLine(i, heightonscreen, hiddeny[i], map.color[mapoffset]);
if (heightonscreen < hiddeny[i]) hiddeny[i] = heightonscreen;
```

1. **Colour is a NEAREST lookup at texel granularity** (`map.color[mapoffset]`),
   and the whole vertical span is painted in that ONE colour. So horizontal
   variation comes from the colormap itself, and vertical coherence comes from a
   single texel's colour covering a tall run of pixels. Sampling the colormap
   smoothly and synthesising variation with noise gets both wrong.
2. **Columns are ONE TEXEL wide**, not sub-metre. Sub-metre cells are
   over-engineering (and produce speckle, see §7).
3. **`deltaz` starts at 1.0 (one texel) and grows by 0.005 per step** —
   distance-adaptive stepping, confirming step size should scale with range.
4. **Wrapping is `& 1023`** — bitmask tiling, matching the infinite tiling in
   `06-...md` §10.

## 7. Current state and the remaining gap (honest)

Implemented: Amanatides-Woo grid DDA (every column tested exactly once, in
order), NEAREST texel colour per the reference, clumped multi-scale canopy
variation, total coverage, and the camera-inside-canopy case.

Measured progress: `|dx|` went from **0.17 → 1.83** (reference 2.80) as the
march moved from fixed steps to DDA and the colour rule was corrected.

**Not yet matching:** vertical autocorrelation sits at **~0.42 against 0.82**,
and side-by-side the canopy reads as isotropic speckle where the original reads
as vertical streaks.

The cause is now understood and is geometric, not algorithmic: **you only see
striations when the visible surface is column FACES, not column TOPS.** With the
eye above the canopy looking down, every hit lands on a ~1 texel square top,
which is isotropic by construction. The reference views that show striations are
all cases where faces are presented — prone inside the canopy, or a grass slope
tilted toward the camera.

Next steps, in order — **all three still open:**

1. ⬜ **Fix the prone/inside-canopy path.** Suppressing the eye's own column currently
   also kills near, steeply-downward rays, so the prone foreground renders bare
   terrain — exactly the view that should be most striated.
   **Likely the same bug as the reach reading in `08-...md` §9**, which derives from the
   step arithmetic that the march may only reach ~6 m when the camera is inside the canopy.
   Two independent routes to the same symptom; settle them together, on real hardware.
   This is the highest-value grass fix available: criterion 1 in §3 is the one unmet
   criterion, and §7's own diagnosis says the striations only appear from inside the canopy.
2. ⬜ Reduce canopy-top roughness. Per-cell height noise makes tops speckle;
   the original's tops come from a detail texture and are far smoother.
3. ⬜ Investigate black speckle artifacts appearing along shell silhouettes
   (visible as dotted lines) — likely alpha-test edges on the lifted shell.

---

## 8. Concealment verified end-to-end (range scenario)

`tools/grass-rig` renders a green capsule standing in for a player at a set range
and stance, with a scoped picture-in-picture inset so naked-eye and 10x views are
comparable in one frame. Measured by counting target pixels in each view.

At 50 m, target standing in 0.97 m canopy, clear sightline:

| stance | naked eye | scoped 10x |
| --- | --- | --- |
| standing | 20 px | **383 px** |
| prone | 5 px | **0 px** |

**Prone is completely concealed — invisible even through the scope — while
standing is visible and the scope is what makes it readable.** That is the DF2
mechanic reproduced on real extracted terrain: concealment is symmetric and
stance-driven, and optics are what defeat it against an exposed target.

### Range sweep, 2 m player capsule in teal camo green

Target colour is deliberately close to the canopy — a saturated marker would
flatter the test. Capsule is 2.0 m end to end in both stances, so prone presents
a ~0.56 m silhouette.

| range | canopy at target | stance | naked eye | scoped 10x |
| --- | --- | --- | --- | --- |
| 50 m | 0.97 m | standing | 26 px | **525 px** |
| 50 m | 0.97 m | prone | **0** | **0** |
| 300 m | 0.99 m | standing | 0 px | **8 px** |
| 300 m | 0.99 m | prone | **0** | **0** |

Reads exactly like the original's tactical shape: prone is gone at every range
tested, even scoped; a standing figure at 300 m is barely detectable and ONLY
through optics — 8 px rather than the ~30 px an unoccluded 2 m target would
subtend, because ~1 m of canopy hides its lower half.

### The scenario has to be set up correctly or it lies

A first run showed prone and standing at 168 vs 171 px — apparently identical,
suggesting concealment was broken. It wasn't: aiming down an arbitrary bearing
had put the capsule on a **ridge, silhouetted against open sky**, with no canopy
anywhere between it and the eye. The renderer was fine; the sightline was
meaningless.

The inverse failure appeared immediately afterwards: a 300 m test returned 0 px
for BOTH stances, which looks like perfect concealment and is actually a hill in
the way (`clear=1.3`, terrain 1.3 m above the sightline).

Both failures are silent — one reads as "concealment broken", the other as
"concealment perfect", and neither involves the grass at all. The rig therefore
emits a verdict with every scenario and refuses to present a reading as
meaningful unless it is `valid`:

- `TERRAIN-BLOCKED` — terrain rises >0.5 m above the sightline
- `NO CANOPY AT TARGET` — canopy <0.15 m where the target stands
- `valid` — level-ish, clear, and grass actually present

At long range a single vantage often has no clear bearing at all; three camera
positions were tried before one gave a valid 300 m sightline. Any future
concealment work must check the verdict before believing the pixel counts.

---

## 9. Two reported artifacts, diagnosed

### Prone and crouch not being concealed — CLOSED

The headline gameplay failure: lying in grass twice your eye height, the horizon stayed fully
visible. Forcing the canopy to 1.2 m everywhere — nearly four times prone eye height — changed
nothing, which is what ruled out canopy height as the cause.

**What it was.** Not missing fragments and not short grass. The entry rule took the ceiling
fragment as where the ray *entered* the canopy, which is only true coming from outside. Inside
the volume that fragment is where the ray **leaves** through the roof, hundreds of metres away
for a near-level ray, so the march began at the exit and stepped over the metre of canopy around
the player's head. The hit-distance view read **120-300 m** across the upper frame: the grass on
screen was grass hundreds of metres away.

Fixed by giving rays that start inside the volume their own proxy — a single camera cap, entry
at the near clip (`08` §7). Prone and crouch are now properly obstructed, with a correct grass
horizon, and it cost nothing: 33.3 ms to 8.3 ms.

**Method note worth keeping.** Three wrong explanations were proposed and discarded before this
one, and each was killed by a measurement rather than an argument: canopy height (killed by
`?canopyall=1`), missing fragments (killed by the COLUMNS view, once its own miss-depth bug was
fixed), and the volume being an open surface (killed by the hit-distance reading, which showed
fragments existed and were simply marching the wrong interval). **The hit-distance view is the
one that answers "where is the march looking", and it is the question that mattered.**

### "Floating grass" along ridgelines — OPEN, cause not yet isolated

A band of grass appears above ridge silhouettes with sky beneath it, detached
from the hill below. Measured on the reported frame: ~3390 px of grass where the
terrain-only render shows sky, a fringe ~18 px tall, contiguous with terrain.

**What it is:** encoding ray distance as colour (`debugDistance`) shows the band
hits at a **mean 428 m**, while normal grass immediately beside it hits at
**21 m**. So it is genuinely distant grass being drawn where the near view shows
sky — not a near-field shading error.

**Ruled out, each by measurement:**

| hypothesis | test | result |
| --- | --- | --- |
| shell overhangs the silhouette | lift shell by local canopy, not global max | 2390 -> 2394 px, no effect |
| terrain patch smaller than grass reach | patch 300 m -> 2000 m | 3390 -> 1456 px, but see below |
| coarse mesh silhouette vs exact heightfield | 12 m quads vs 1.5 m | under 1 px difference |

The patch result was **misleading and produced a wrong fix**: raising `SPAN`
while leaving the vertex count fixed silently coarsened quads from 2.7 m to
12.7 m, and the apparent improvement was entirely that coarsening (which also
introduced a worse artifact — the mesh dipping below the true surface so sky
showed through). With mesh density held constant at the larger span the fringe
returns to 3153 px / 17.6 px, i.e. unchanged. The rig now derives mesh
resolution from span so quad size stays fixed.

**Still unexplained:** 1 m of canopy at 428 m subtends about 1 px, not 18. Either
the hit distance is bimodal and the mean misleads, or the march reports hits for
rays that pass near a column rather than through it at long range. Next step is
to histogram hit distance across the band rather than take its mean, and to check
whether the far terrain that owns those columns is itself being drawn at those
pixels.

**Related invariant, worth keeping regardless:** terrain must be drawn at least
as far as grass is rendered, or the march finds columns on terrain that was never
drawn. The app satisfies it (terrain 2304 m vs grass fade 1100 m) but a change to
`VIEW_RADIUS_CHUNKS`, `CHUNK_COUNT` or `GRASS_FADE_END` could break it silently.

### Dark blotches — the colormap, not the shader

Dark regions occupy the same places with and without grass (IoU **0.95**), and
drawing grass slightly *reduces* dark pixels (201516 -> 192369). The colormap is
pre-shaded (`06-...md` §6), so baked tree and shadow features are in the source
data. Nothing to fix in the renderer; lifting them would be an art decision about
fighting the pre-baked lighting, not a bug fix.

### Method note

The first pass diagnosed the wrong frame — diagnostics were run at a fixed
bearing while the reported screenshot used the scenario's auto-chosen bearing,
giving a 4 px fringe instead of the real 19 px. Reproduce the exact frame before
measuring an artifact.

### Black wedge at eye height, pitched down — TERRAIN, not grass — OPEN

Seen while preparing the test build: on foot at prone/stand height with the
camera pitched down, a large flat dark-green plane cuts diagonally across the
lower frame, a near-black band sits under it, and sky shows below that.

**It is not grass.** The same frame with grass toggled off is identical in that
region — the plane, the black band and the sky gap all remain. Wireframe on the
same pose shows the black band is the chunk **skirt**: a run of tall thin quads
with a jagged top edge and a flat bottom exactly `SKIRT_DEPTH` (12 m) below it.

**Why it shades black:** `TerrainMaterial` is `DoubleSide` (skirt winding is not
controlled), so the skirt's back faces get their normals flipped. The skirt
copies the *top-edge* normal, which points up; flipped, it points down, so the
directional light contributes nothing and only the hemisphere light's ground
term remains. A skirt seen from inside is therefore near-black rather than the
smeared cliff it is meant to look like.

**Not yet explained:** the sky visible *beyond* the skirt's bottom edge. The
skirt is supposed to plug exactly that gap.

**Caveat on any repro numbers:** this session's browser had no GPU — WebGPU
initialisation fails and it falls back to WebGL2 on SwiftShader, a software
rasteriser. Ground-level frames there run 300–1000 ms *with grass off*, so the
frame times observed while diagnosing this say nothing about real hardware and
were not usable for driving the camera precisely (movement is `dt`-capped at
0.1 s/frame, so key presses barely move the rig). Diagnose this on a machine
with a real GPU.

**Next step:** stand on a chunk boundary vs 100 m inside a chunk and compare —
the repro pose (x = 0) sits exactly on one, since `chunkSize` is 256 m and
`halfWorld` is 1024 m. If the gap is boundary-specific it is a skirt/LOD seam;
if not, it is the chunk window's near edge.

### Near grass missing whenever the eye is inside the canopy — CLOSED

Reported as "it clips all near grass when the canopy is higher than the camera", and
reproducible at the §1 vantage standing, eye 1.7 m above ground, with the canopy dial at
11.3 m: the hit mask showed a band across the bottom of the frame with **zero** grass
hits, plus a hole wherever the terrain dropped away.

**It was not the terrain skirt** — the wedge in the next section is a separate defect,
and it is present with grass switched off entirely.

**Cause: the lifted shell is a CEILING and the volume had no floor.** The proxy is the
terrain surface lifted to the canopy top. A ray that leaves the eye going downward and
meets the ground never crosses that surface — the shell is above the entire ray — so no
fragment is rasterised for the pixel and the march never runs. On level ground the split
is exactly the horizon: the shell projects to everything above it, and everything below
it had no grass proxy at all.

No single surface can cover both cases. Rays entering from above need the top; rays
going down from inside need the bottom; and the silhouette against sky — the edge this
whole system exists to render — needs the top, so the bottom cannot simply replace it.

**Fix:** close the volume with a second proxy at ground level (`floorMaterial`, one march
graph, two `positionNode`s sharing every uniform), drawn by `Terrain.tsx` only while the
eye is inside the canopy. Both passes march from the eye and write the hit's depth rather
than the proxy's, which is what makes them agree where they meet instead of z-fighting
along the horizon. Verified at the reproducing pose: the bare band is gone and the hit
mask is solid to the bottom edge. Cost is 13.7 ms at prone and zero standing in 1.2 m
grass — `docs/09` §3.1.1 has the numbers and what they mean for the target.

**Still open at that pose:** a patch of distant terrain visible through a notch in the
near canopy renders with no grass. Most likely correct — it is beyond `GRASS_FADE_END`,
where no shell is drawn at all — but it has not been confirmed against the hit distance.

### All distant grass vanished while prone — CLOSED, and it was a fairness bug

Reported as "easy to stay prone in such a way that distant grass does not render, giving
you an unfair advantage". Correct, and it was arithmetic rather than a tuning problem:

```
sEnter = inside ? nearClip : fragDistance      hitS <= sEnter + span      span <= maxSpan
```

`inside` is a property of the CAMERA, not the fragment. So the moment the eye entered the
canopy, every fragment on screen started its march at `nearClip` and gave up after
`maxSpan` — **no hit anywhere could resolve beyond about 49 m**, and everything past that
was a forced miss drawing bare colormap. Going prone in grass switched off all distant
grass at once.

That is a competitive-fairness defect, not a cosmetic one. Concealment is queried
analytically against `grassHeightField` (`04` §2), so a target prone in distant grass is
concealed whatever the screen shows. A player who went prone therefore saw every distant
target standing on bare ground while remaining hidden himself — and prone is already the
strongest position. `08` §8 now carries this as an invariant: **the renderer must never
conceal less than the field says it does.**

**First attempt, reverted:** search a near interval and then, on a miss, a far one. It did
fix the ceiling, but it inlined the whole march twice AND it kept the camera in the entry
rule — so the *texture* of distant grass still changed as you went prone. It must not: a
column 800 m away does not care about your stance.

**Fix.** One rule, one march, no branch on the camera. The entry is where this pixel's ray
first crosses into the slab, which is a property of the ray and the proxy and nothing else:

- ceiling proxy — the fragment IS the canopy top, so the ray enters there.
- floor proxy — the fragment is the ground, so the crossing was `span` earlier along the
  ray; clamped to `nearClip`, which also makes near ground march from the eye with no
  special case.

The near-field occlusion that makes lying in grass blinding is no longer a special case —
it falls out, because a floor fragment a metre away has its entry clamped.

**One rule was still not enough, and this is the part that took a third pass.** Both
proxies are drawn while the eye is in the canopy, and over the SAME pixel they search
different intervals: the ceiling from its canopy-top crossing, the floor from `span` before
the ground. Different intervals place the coarse samples differently, so they bracket
different columns, and whichever resolves nearer wins the depth test. So the texture of
distant grass still shifted on going prone — the ceiling alone answered while standing, and
the floor started competing once prone. Uniform *code* is not the same as a uniform
*answer*.

**Fix: the floor yields to the ceiling per pixel.** The floor is only needed where the ray
reaches ground without crossing the canopy top. That crossing is at `fragDist - span`, so
when it sits comfortably ahead of the eye the ceiling owns the pixel and the floor skips its
march entirely; below `nearClip` the eye is inside the slab along that ray and the floor is
the only proxy there is. The two now partition the screen exactly instead of competing over
it, so distant pixels are ceiling-only in every stance.

**Verified** prone at the §1 vantage: hits resolve out to mid range in the hit-distance view
where previously nothing beyond 49 m existed, and the distant band is unchanged between
standing and prone screenshots at the same pose. Cost, same window: standing 16.4 ms,
prone 21.1 ms, of which the floor pass is 1.0 ms — it was 20 ms before the per-pixel test
(`docs/09` §3.1.1). The remaining 3.7 ms of prone-versus-standing is the march at a low eye,
which is intrinsic to the viewpoint.

A ceiling on hit distance is invisible in a normal render; it looks like ordinary bare
ground. Check view 2 prone, not just standing, after touching the march bounds.

### Strand height frequency — OPEN, and the amplitude was never the problem

The DF2 references show a canopy edge that varies **strand to strand** — a ragged, hairy
silhouette of thin blades at different lengths. Ours rolls in clumps. The height multiplier
already spans 0.38–1.00 of the canopy after the standardisation above, so amplitude is not
the limit. Frequency is:

- the jitter texture is 1024² over a 120 m period, so **one texel is 0.117 m — about four
  strands at the 0.03 m column width, which therefore share a single height**;
- the field's finest fbm term sits at **0.35 m, roughly twelve strands**, so real variation
  is smoother still.

`GRASS_STRAND_JITTER` (0.18, `?strand=` to override, bake-time) trades fbm weight for noise
at texel resolution — the highest frequency this texture can express. **Measured
inconclusive:** an A/B at the §1 vantage, prone, was visually indistinguishable at 0 and
0.18. Not a refutation — at 100–400 m each strand is sub-pixel and that view has no sky
silhouette, so it cannot show a ragged edge either way. Re-test against a near ridge line
with sky behind it.

Two paths remain, and the second is the one the references actually used:

1. **A second jitter texture at cell scale** — 256² over 7.68 m is 0.03 m per texel, so
   genuinely per-strand. One extra fetch per march sample. Not the old nine-`sin` disaster
   (99.8 ms); a fetch is cheap. The short repeat hides behind the coarse field.
2. **Key height on RAY BEARING, as Voxel Space did.** DF2 drew one strand per screen column
   via `DrawVerticalLine` from a single heightfield sample: strand width was one pixel by
   construction at every distance, and every screen column had its own height. Our march is
   per-pixel in world space, so strand identity is decoupled from the screen and both
   thinness and per-strand variation have to be manufactured. `uToneMode = 1` already keys
   *tone* on bearing with `stripePixels` setting the width; extending that to *height* is
   cheap, because bearing is constant along a ray — one evaluation per fragment, not per
   sample. This is the authentic mechanism and most likely the one that gets the look.

Strand **width** is not a blocker on its own: `GRASS_CELL` is a live slider from 0.01 m. The
limit is the march's sampling rate — 12 coarse samples over metres already makes which
strand a ray hits somewhat arbitrary, and thinner strands turn that into shimmer rather
than detail. Which is the same argument as path 2: fix the sampling to be per screen column
and both problems go away together.

### Grass swimming when the camera moves — CLOSED, march phase was camera-anchored

Reported right after `GRASS_STEPS` dropped 96 -> 12 (`docs/09` §3.1.0): the grass appears to
shift or crawl while walking, worst heading toward a hill crest.

**Cause.** The coarse samples sit at `sEnter + k*ds`, and `sEnter` is the distance from the
CAMERA to the shell fragment. So every sample plane slides along the ray as the camera
moves. A thin column bracketed at sample k on one frame is stepped over on the next and a
different column is hit instead — the resolved hit jumps by up to a full `ds`, and the field
appears to swim. Nothing is wrong with the geometry; the sampling is just not anchored to
anything fixed.

Why it appeared exactly when it did: `ds = span / steps`, and at 96 steps that was about
0.5 m — small enough that the jump was invisible. At the designed 12 it is up to 4 m for a
grazing ray, and heading at a crest is precisely the grazing case.

**Fix: anchor the sample planes to WORLD HEIGHT.** Pin them to fixed multiples of the
per-step vertical drop, so they stay on the same world planes regardless of where the camera
stands. With `dy = ds * vy`, the distance from the entry to the next plane is
`fract(yEnter / dy) * ds` — four instructions, measured at the vsync cap either way.

This does **not** make the march finer and is not meant to. It makes it STABLE. Coarse but
steady reads as slightly blocky grass; coarse and sliding reads as the whole field crawling,
which is far more objectionable and is what was reported.

**Verified static only.** A still frame cannot show a temporal artifact — this needs a
walking check, ideally the same approach-a-crest that surfaced it.

### Terrain jagged and noisy where DF2 rolled softly — CLOSED, it was 8-bit terracing

Asked whether this was a mesh or a texture problem. Neither: it is the elevation DATA, and
the numbers are unambiguous. Measured over `public/assets/terrain/gmile/height.png`:

| | |
|---|---|
| Storage | 8-bit, 170 distinct levels used of 256 |
| One raw unit at `HEIGHT_SCALE` 1.0 over a 2 m texel | **26.6 degree facet** |
| MEDIAN facet angle across the map | **26.6 degrees** |
| Adjacent samples that are exactly equal | **48%** |

The median facet angle being *exactly* the one-unit step angle is the proof: the surface is
dominated by quantisation, not by real slope. Half the samples are flat, then the surface
jumps a whole metre. Step-flat-step-flat — terracing, and that is what reads as jagged.

**Why DF2 never showed it on the same data.** Voxel Space drew one column per screen column
straight from the samples and never built triangles out of the steps, so quantisation
appeared as vertical banding rather than as angular facets. Triangulating a terraced field
is what turns a storage artifact into visible geometry — and raising mesh resolution makes
it *worse*, not better, because more triangles only interpolate the terraces more precisely.

**Fix:** reconstruct the sub-unit relief with a separable [1,2,1] binomial filter over the
field, `HEIGHT_SMOOTH_PASSES = 2` (0 for the raw A/B). Each pass halves relief at the
2-texel scale where the terracing lives and leaves the tens-of-metres features that carry
the terrain's shape.

**The part that is easy to get wrong:** the smoothing has to reach the shader too. Ground
elevation is read in three places — the terrain mesh, the grass march, and the concealment
query — and `docs/08` §8 invariant 3 requires they agree. Smoothing the CPU field alone
would have left the grass marching a quantised surface the mesh no longer drew, floating it
off the ground by up to half a metre. So `heightMap` is now built from the heightfield's own
grid and carries **metres directly as half-float**, rather than raw bytes scaled in the
shader. Half rather than float32 because WebGPU does not guarantee float32 textures are
filterable and this needs LINEAR; half gives ~0.1 m precision over the map's 169 m of
relief, well under the 1 m step being removed.

Measured after: **19.6 ms / 51 fps** at Green Mile (5, 375) standing, dpr 1 — unchanged, as
expected for a one-off CPU filter.

Note this makes `HEIGHT_SCALE` matter more, not less. It is still an uncalibrated
placeholder (`docs/01` §7): at 1.0 the map has 169 m of relief and one raw unit is a 26.6
degree step; at 0.25 it would be 42 m and 7.1 degrees. Smoothing treats the symptom that
the placeholder makes worst.

### Hard-edged blocks in the grass colour — CLOSED, two separate causes

Reported against a screenshot pair: the grass rendered as large angular plates with hard
straight edges, over a colormap that is itself perfectly smooth (the terrain material
samples it linearly and shows none of this). Two independent causes, and fixing the first
one alone left the near-field blocks untouched.

**1. NEAR FIELD — the colour lookup was snapped to the 2 m terrain texel.**

`texelCentre()` quantised the colormap uv to the terrain texel, on the reasoning that DF2
did `map.color[mapoffset]`, a nearest lookup, and painted a whole vertical span in that one
colour. The reasoning is right about the original and wrong here, because the two engines'
texel and column sizes do not correspond: **DF2's colour texel WAS its column, whereas ours
is 2 m while a column is 0.03 m.** So roughly 67 adjacent columns shared one colour, and a
2 m block at 10 m subtends about 170 px. That is the reported artifact, exactly.

Now sampled at the struck COLUMN's centre with the texture's own linear filtering. What
matters is preserved — one colour per column, smeared up its full height, which is what
gives striations rather than soft volumetric grass (§1.1) — while neighbouring columns
differ. The horizontal variation DF2 got from its colormap comes from the per-column tone
hash instead, which is where it has to come from at this texel-to-column ratio.

**2. MID FIELD — quantised `hitFrac` banding, aligned to shell facets.**

`span` is canopy height over the ray's vertical rate, so a grazing ray takes the full 48 m
clamp: `ds = 48/12 = 4 m`, and four bisections narrow that to 0.25 m. Against a 1.2 m
canopy that quantises `hitFrac` into about five levels, and the 0.78–1.22 vertical ramp
turns five levels into five flat brightness steps. They read as hard-edged polygons because
the quantisation is driven by the ray's vertical rate and entry point, both of which change
across every triangle of the faceted shell — so the banding lands on mesh facets and looks
like geometry rather than error.

Fixed by fading the vertical ramp to neutral once a column is narrower than a pixel
(`cellSize / pixelAngle`, about 27 m at the 0.03 m default). Beyond that a base-to-tip
gradient across a column cannot be seen, so the term carries nothing but its own
quantisation error. Two instructions; the near field where the ramp is genuinely visible is
untouched.

`GRASS_TONE_VARIATION` also raised 0.85 -> 1.5, set by eye against the references.

Measured after both: **19.1 ms / 52 fps** at Green Mile (5, 375) standing, dpr 1, canopy
field (not forced), 99 draw calls.

### Thin columns — UNBLOCKED, and the blocker was the jitter mapping

Asked for: columns thinner than the 0.01 m slider floor, to match the fine strands in the
DF2 references. Lowering the floor alone would not have worked, and it is worth recording
why, because the number is decisive.

The jitter texture was sampled in WORLD METRES — 1024² across the 120 m `hashPeriod`, so
**one texel was 0.117 m**. Against column width that means:

| Column width | Columns sharing one height/tone |
|---|---|
| 0.03 m (default) | 4 |
| 0.01 m (old floor) | 12 |
| 0.005 m | 23 |

So thinning the column never added detail — it only made the *bands* of identical columns
wider. The field feeding the geometry never got finer than 0.117 m no matter what the
slider said.

**Fix: sample the jitter per CELL, not per metre** (`cell.div(uJitterTexels)`). One texel is
now one column at any width, so every column has its own height and tone. The slider floor
drops to 0.002 m.

**Verified** at Green Mile (5, 375) standing with the canopy forced on: at 0.002 m the
canopy silhouette against sky is finely ragged, varying strand to strand, where at 0.030 m
it is visibly blocky. That is the §1.3 edge, and it is the first time this renderer has
produced it.

**The trade is repeat distance.** Per-cell mapping makes the pattern repeat every
`1024 × cellSize` — 30.7 m at 0.03 m, 5.1 m at 0.005 m — rather than a fixed 120 m. Short
enough to tile visibly on its own. It is *masked*, not solved: the canopy envelope (2 m
texels) and the ground elevation both vary underneath it. Watch for tiling at a grazing
angle over flat ground with a uniform canopy, which is where the mask is weakest. Raising
`JITTER_RESOLUTION` to 2048 doubles the repeat for 8 MB.

**Cost is unmeasured and there is a specific reason to check it.** Sample count does not
change with column width, so the march should cost the same — but per-cell sampling
destroys texture-cache coherence: at 0.002 m columns, adjacent pixels land in unrelated
texels where before they shared one. Measure 0.03 against 0.002 at the §1 vantage with the
canopy field (NOT forced) before assuming it is free.

Still open below 0.005 m: the march takes 12 coarse samples spread over metres, so which
column a ray hits is already partly arbitrary, and thinner columns turn that into shimmer
rather than detail. The slider hint says so. The real fix is per-screen-column sampling —
see the bearing-keyed path above.

### Debug: grow grass everywhere, ignoring the canopy field

Green Mile's canopy is a colormap-derived stand-in, so it is patchy and a frame can
legitimately be mostly bare — indistinguishable from the shader failing. The `?debug=1`
panel now has **Canopy from: Field / Everywhere** (uniform `canopyForce`, live; `?canopyall=1`
to start in it), which replaces the field with full height everywhere and isolates the column
renderer from the data feeding it. Standing at the §1 vantage it costs almost nothing —
16.8 ms against 16.4 — so the patchiness was not hiding cost. **Never measure with it on:**
full canopy everywhere is both the worst case for the march and not what the map says.

### Pale wash over all grass — CLOSED, it was TSL `.mix()` argument order

Every grass fragment rendered near the fog colour regardless of its distance. Four
hypotheses were patched before the term was isolated (envelope bracket, chunk cull
box, frustum-gated building, mipmaps) and each made the build worse.

**Isolated by bisecting the colour expression** through a live debug uniform rather
than by editing and rebuilding per term (views 4–9 in `GrassMaterial.ts`, exposed in
the `?debug=1` panel). `columns` alone was correct; `faded` alone was correct; the
fog mix was pale.

**Cause.** In TSL the receiver of `.mix()` is the **interpolant**, not the first
operand: `t.mix(a, b)` is `mix(a, b, t)`. Written the GLSL way,

```
faded.mix(uFogColor, fogFactor)   ->   mix(uFogColor, fogFactor, faded)
```

so the fog colour became the base of the blend and the grass colour became the
interpolant. The output sat near the fog colour at every distance. All four `.mix()`
calls in the file had it — `shade`, `faded`, `shaded`, and `cellNoise`'s bilinear
interpolation. See `docs/08` §11 for the general trap, including which sibling
methods reorder and which do not.

**Why the earlier fog tests looked exculpatory.** Pushing the fog range to
900000..1000000 m only drives `fogFactor`, which in the rotated form is the *far end*
of the blend weighted by `faded` — a dark colour — so it barely contributes and the
picture did not change. That result was read as "fog is not involved", which sent the
next four attempts elsewhere. **A parameter sweep that changes nothing is evidence
about the expression's shape, not only about the parameter.**

### The flat-grass regression the fix exposed — CLOSED

Correcting the rotation replaced an effective 0.13–1.00 vertical ramp with the
intended near-flat 0.88–1.05, and **that accidental ramp had been supplying nearly all
the visible column structure.** Grass came out correct in colour and almost featureless.
Two measured causes, both fixed:

**1. The tone field only used a fifth of its range.** `fbm` returns a normalised
weighted *average* of value-noise samples, so it clusters hard around 0.5. Measured over
the 120 m tile the tone field had **σ = 0.105**, which with the dial at 0.85 gave a
typical column-to-column brightness of 0.91–1.09 — ±9%. The dial claimed a range the
data never reached. `bakeGrassJitter` now standardises both channels, mapping mean ± 2σ
onto 0–1 (≈4% clipped per end): **σ 0.105 → 0.242**, typical tone 0.79–1.21, full range
0.57–1.43 actually reachable. The height channel gains the same treatment, so the column
height multiplier spans 0.38–1.00 instead of 0.62–0.76 — that is the irregular silhouette
of §1.3, which was also being flattened.

**2. There was no term at column resolution.** The tone field's finest fbm lattice is
0.35 m, about twelve 0.03 m columns, so *adjacent* columns shared a tone. Corduroy is by
definition variation between adjacent columns, so it cannot come from a 0.35 m lattice.
The bake now adds a per-texel white-noise term (weight 0.22) to the tone. Deliberately
**not** to the height channel: the march evaluates column height at every sample, and a
one-texel height spike is exactly the thin feature bracket-and-bisect steps over
(`docs/09` §3.0). Tone is evaluated once, at the hit, so it can carry detail height cannot.

**3. The vertical ramp is now a dial, not an assumption.** `GRASS_SHADE_BASE` (0.78) sets
the column base's brightness and the tip gets `2 - base`, so the ramp stays centred on 1.0
and grass keeps the average brightness of the terrain under it. 0.78 gives a 0.44
peak-to-peak vertical against the tone's 0.85 horizontal — h/v ≈ 1.9 against the ~1.6 the
references measure (§1.4), close enough to be dialled by eye rather than argued. Exposed
as the "Base shading" slider; 1.0 is flat.

Frame time at the §1 benchmark vantage is unchanged — 22.5 ms against 21.9 ms before,
inside the peak-to-peak spread, at the same 132 draw calls and 976k triangles. None of
this adds march work: the field changes are a one-off CPU bake and the ramp is one `mix`.
