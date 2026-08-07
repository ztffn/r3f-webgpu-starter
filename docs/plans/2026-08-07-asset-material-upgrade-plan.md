# Modernising the original assets: roughness, normals, relief

Plan for making 1999 assets carry their weight under a modern renderer, WITHOUT inventing
detail the originals never had. Scope: what data we already hold that nobody uses, what
would have to be synthesised, the order to do it in, and why that order is not negotiable.

Written at the end of the session that built the `.3DI` converter, so it records what that
work learned about these textures and materials rather than restating general technique.
Companion records: `2026-08-07-converter-known-gaps.md` (what the converter skips),
`2026-08-07-prop-collision-design.md` (the other post-converter feature), the detail-pass
roadmap in `docs/08`, and `docs/00` for the test any aesthetic call has to pass.

## 0. The prerequisite, and why it is hard

**Nothing here can be judged until lit surfaces receive fog and the colour grade**
(`docs/08` §8 invariant 7, and the handover task). A normal map is *only* visible through
the lighting response; a roughness value is *only* visible through a specular highlight.
Tuning either against a scene that is missing the atmosphere term means retuning both
later, and worse, it means not knowing whether a bad result is the map or the missing term.

The sun now reads the weather preset (this session), which was the other half. That makes
the lighting *correct in direction and colour* but still *incomplete in range*. Do not
start §2 or §3 before the post-lighting pass lands.

## 1. The distinction that decides the sequencing

Terrain and models need the same generator and have completely different confidence:

| | Terrain | Models |
|---|---|---|
| Height data | **Measured.** `detail_elev` is a real extrusion map — rails 40, ties 20, ruts 4-14, grass 22-46 (`docs/06` §11.1) | **None.** Any normal map is synthesised from albedo luminance |
| Failure mode | wrong *interpretation* of real data | wrong *invention* |

Do terrain first. When something looks wrong there, the question is "did I read the data
right"; on models it is "is my heuristic any good" — and debugging both at once is how the
scale calibration went sideways earlier in this session until measured and inferred values
were separated. Same rule, different subject.

## 2. Free wins from data we already parse and ignore

These need no synthesis at all. They are the highest value per hour in this document.

### 2.1 Roughness and metalness from the surface-type bits

Every material carries a bullet-impact surface type in flag bits 16-19 and 26-29
(`docs/02` §4, measured this session: the cypress carries the "foliage/leaves" bit, the
flags carry "cloth/flag", a wooden crate bit 17, a metal wall bits 16+17, a stone column
bit 18; 43 distinct patterns across the corpus).

**Today every exported material is `metallicFactor 0, roughnessFactor 1`** — which is why
everything reads as chalk under the new lighting. That single pair of constants is doing
more aesthetic damage than the absence of normal maps.

The bits are a PBR classifier already present in the data. Map surface type to a
roughness/metalness pair once, in the converter, and every model in the corpus improves at
the same time. **This is real data, not a guess**, so it also passes `docs/00`'s test in a
way synthesised relief does not.

Open first: the numeric types 12-17 have no confirmed name table. Two are labelled by the
format docs (foliage, cloth) and the rest are inferred from which models carry them. The
419 `.wav` names in `Df2.pff` very likely carry the vocabulary (`docs/…-known-gaps` §D) —
resolve that before assigning material response to a number you cannot name.

### 2.2 Exclusions the flags already state

- **`FlatLit` materials (5.8%) must be excluded from all of this.** They skip lighting by
  design and export as `KHR_materials_unlit`; a normal map on them does nothing and a
  displacement is actively wrong.
- **`AlphaBlend` materials (24%)** are glass and foliage cutouts. Roughness yes, relief no.
- **`DoubleSided` (32.8%)** is tent canvas and foliage — surfaces with no meaningful
  thickness. Parallax on them will self-intersect; gate it off.

## 3. Synthesised relief, and its specific hazards here

Only after §2, and only with an A/B toggle from the first commit.

Albedo-to-height by luminance is the standard heuristic, and these textures break it in
three ways this session actually observed:

1. **They are tiny.** 8×8 to 128×128, most under 64px (`rbuilda` runs 58 textures from
   8×8 up). There is very little signal to derive a gradient from, and what exists is
   mostly the palette's dithering, not surface relief.
2. **Transparent texels held a chroma key** — frequently pure green — and are now
   **alpha-bled** with dilated neighbour colour (this session). That dilation is
   *invented* colour: correct for stopping mip bleed, wrong as a height source. A
   generator must read the ORIGINAL alpha and exclude those texels, not the exported PNG.
3. **Some albedo already contains painted lighting.** Not verified for models — the
   *terrain* colormap is definitively pre-shaded (three materials compensate for its baked
   ravine shadows in comments), and DF2-era model skins commonly had highlights painted in.
   **Measure this before trusting luminance as height**: painted shading turns into relief
   pointing the wrong way, and it will look plausible while being backwards.

Sampling is already `NEAREST` magnification with linear mips (this session), which is
authentic and also means a normal map must be generated at source resolution and left
crisp — smoothing it would undo the reason the sampler was set that way.

## 4. Parallax / displacement

Defer hardest. Two things make it cheaper here than it looks:

- **This repo already relief-maps** — the grass is a per-fragment march writing its own
  depth (`docs/03`). Parallax-occlusion expertise exists in-tree rather than needing to be
  acquired, and `GrassMaterial` is the reference for the TSL shape of it.
- The terrain roadmap already phases it as **gated parallax, on a profile only**. Models
  should inherit that gate rather than invent a second policy.

Do not put displacement on anything double-sided or alpha-blended (§2.2), and do not put it
on props smaller than a crate — the cost is per-fragment and a 0.4 m ammo box will never
repay it.

## 5. Order

1. **Post-lighting `shade`** — prerequisite, see §0. Not part of this work.
2. **Roughness/metalness from surface type** (§2.1). Converter-only, data-backed, applies
   to the whole corpus at once. Resolve the surface-type name table first.
3. **Terrain detail rework** — real relief data, the roadmap's measured phases.
4. **Synthesised model normals** (§3), A/B from the first commit, after §3's generator
   exists and has been judged against terrain where the data is real.
5. **Gated parallax** (§4), on a profile, where it earns its cost.

## 6. The test this has to pass

`docs/00`'s question — *would a veteran DF2 player instinctively recognise this?* — cuts
both ways here and should be applied per step, not to the whole idea:

- §2 (roughness from surface type) **restores** something the original expressed and we
  currently flatten. Safe.
- §3-4 (synthesised relief) **adds** something the original never had. That can still be
  right — the grass is relief-mapped for exactly that reason, and `docs/03` argues it —
  but it is a judgement call the pillars decide, and it needs the A/B toggle to be argued
  honestly rather than asserted.

The failure mode to avoid is the one this project has already named: a generated
approximation that becomes indistinguishable from authored data. Whatever ships, the
provenance has to stay visible — the same rule the grass canopy and the collision
`source` field already follow.
