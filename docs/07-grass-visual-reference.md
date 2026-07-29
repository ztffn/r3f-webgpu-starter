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

A grass implementation honours the original when all of these hold:

1. **Vertical coherence** — grass reads as vertical columns, one colour per column base.
2. **No thinning** — coverage is visually identical at 10 m and at 800 m.
3. **Hard zone edges** — grass stops abruptly where the detail map says it stops.
4. **Ragged canopy top** — per-column height variation is visible in silhouette.
5. **Occludes a standing figure to roughly the waist** at default scale.
6. **Cost independent of distance/coverage** — no per-blade budget.

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

Next steps, in order:
1. Fix the prone/inside-canopy path. Suppressing the eye's own column currently
   also kills near, steeply-downward rays, so the prone foreground renders bare
   terrain — exactly the view that should be most striated.
2. Reduce canopy-top roughness. Per-cell height noise makes tops speckle;
   the original's tops come from a detail texture and are far smoother.
3. Investigate black speckle artifacts appearing along shell silhouettes
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
