# Detail pass modernisation & the future terrain format — roadmap

*2026-08-06. Follows the DFG5 full-file audit (`06-...md` §11/§11.1) and the as-built
detail pass (`08-...md` §6.3). Two threads, one plan: how the renderer grows a modern,
measured detail/relief pass, and what the converter emits as the terrain format the
standalone decoder repo will hand to the community.*

## 1. What we know (evidence, not guesses)

- The original's close-range ground is **detail_color tiles at one tile per 1 m texel**
  (~1.6 cm/px); the colormap never carries it (DFG5's railroad is the proof).
- **`detail_elev` is a general extrusion map**: the voxel renderer stretched every ground
  column by it and coloured the column from `detail_color`. Grass is the vegetation case;
  rails (40), ties (20), ruts (4–14) and full-height block tiles (255) are the same field.
- **`char_data` (.cal) is the semantic key**: per-index material family. Across all 18
  retail sets the vocabulary is `Gs1-3`/`Grs1-3` (grass), `Sw2` (swamp — vegetation status
  UNCONFIRMED), `Dt2/Drt1` (dirt), `Rk2/Roc1` (rock), `Sd2-3` (sand), `Md2-3` (mud),
  `Snw1` (snow), `Ice1/Ie2` (ice), `ct1/cmt1` (concrete), `rd1` (railroad), `null`.
  `param` 40 marks hard surfaces; everything else is 0.
- The community sets we ship (EXP2b, TerrainPack) **carry no .cal** — they reference
  base-game detail sets. Every .cal-derived behaviour must degrade to today's behaviour
  when the file is absent.
- As-built renderer (Aug 2026): lit-lerp atlas pass with distance + texel-density fades,
  three live dials. Cost: +3 texture fetches per terrain fragment, **expected small,
  UNMEASURED** — there is no detail-off toggle yet, so the A/B cannot be run.

## 2. Destination

One measured, dial-tuned detail pass whose relief comes from the same legacy data,
with vegetation and hard relief split into separate semantic fields — because one is
concealment and the other must never be.

## 3. Renderer phases (each lands only with its bench number)

- **P0 — measure first.** `?detail=0` toggle; bench A/B at the pinned pose on desktop and
  an iPad-class device. Record here. Every later phase re-runs it.
- **P1 — vegetation/relief split in the bake** *(the "fix the grass" step)*. `grass.png`
  (canopy = renderer + concealment input) bakes from **vegetation families only**
  (`Gs*`, `Grs*`; `Sw*` pending a retail visual check). Hard surfaces stay zeroed via
  param 40; dirt/rock/sand/mud/snow/ice relief no longer becomes centimetre "grass"
  (93.6% of DFG5's non-grass texels carried it). No .cal → unchanged full-stretch bake,
  flagged in `terrain.json`. Concealment correctness, not just looks.
- **P2 — atlas → 2D array texture.** `DataArrayTexture`, 64×64×256. Removes the
  half-texel inset, the bleed constraint and the no-mipmap restriction; parallax clamping
  becomes trivial. A simplification, not a rewrite — one emit, one loader function,
  simpler cell math.
- **P3 — normal layer.** Prepare-time Sobel over each `detail_elev` tile → normal
  layers beside the colour layers. In-shader: one extra fetch composed into the existing
  lighting ratio, sun direction consistent with the `.trn`'s own `sun_slope` so it agrees
  with the colormap's baked shadows. One strength dial.
- **P4 — parallax.** Single-step height offset first (height in the normal layer's
  alpha), gated by the existing strength term; optional multi-step POM inside ~20 m only
  if the single step reads flat. Bench before/after each.
- **P5 — ceiling, only if the bench demands it.** Camera-centred composite cache
  (clipmap ring): composite the detail layer once per texel crossing, terrain returns to
  ~1 fetch steady-state. Complexity is real; buy it with a profile, not a hunch.

Explicitly rejected: virtual texturing (256 shared tiles are not a megatexture),
stochastic/hex tiling (repetition is the authentic aesthetic), spline meshes for rails
(abandons data-driven generality — rails must fall out of every converted mod), geometry
displacement (motor/authority must not learn about 19 cm rails).

## 4. The future terrain format (converter target)

The standalone decoder repo converts legacy NovaLogic terrain (retail + mods) into an
**engine-agnostic, self-describing, web-native** set. Principles: plain PNG/JPEG + one
versioned JSON manifest; every derived product carries provenance (the `substituted`
pattern already in `terrain.json`); legacy fields are split by SEMANTICS, not copied by
name.

| file | content | from |
|---|---|---|
| `terrain.json` | versioned manifest: dimensions, scales, provenance, env params, availability of everything below | `.trn` + pipeline |
| `height.png` | 1024² 8-bit elevation | `_d.pcx` |
| `color.jpg` | 1024² pre-shaded colormap | `_c.jpg` |
| `detail.png` | 1024² per-texel tile index | `_m.pcx` |
| `detail_color.png` | 256-tile colour set (atlas v1; array-layer stack when P2 lands) | `_cm.tga` |
| `detail_normal.png` | per-tile normals, height in alpha (P3/P4 product) | `_dm.pcx` |
| `grass.png` | **vegetation-only** canopy field (P1 rule) | `_dm.pcx` × `.cal` |
| `materials.json` | per-index: family name, vegetation flag, hard flag, param | `.cal` |
| sky/water | gradient LUT, cloud layer, ripple tile as PNG | `skygrd/clouds/ripple` |

The format spec lives with the converter README and moves with the repo; docs/02 and
docs/06's format sections migrate on the split (already noted there). Retail-derived
OUTPUT of the converter follows the same legal rule as its input: personal-use, never
shipped.

## 5. Open questions

- `Sw2` swamp: vegetation (reeds = concealment) or wet ground? Needs the retail game.
- Stretch scale (raw 0–255 → metres) is still uncalibrated (`06` §8) and P3/P4 inherit it.
- Mipmapped array layers for the tiles (P2 enables it) — worth it at 64 px?
- `null` block tiles (~255 stretch): what did the original render for them? Unreferenced
  on DFG5; check a map that uses one before the converter assigns semantics.
