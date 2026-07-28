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
