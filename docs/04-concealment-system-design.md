# Concealment System Design

## 1. Design intent

Reproduce DF2's signature gameplay property: a prone player in tall grass can be
effectively invisible to an observer up to ~800m away, reliably and deterministically —
this is a core mechanic (prone-and-snipe), not an incidental visual effect.

## 2. Design principle: decouple gameplay concealment from render fidelity entirely

The original engine achieved this "for free" because grass **was** terrain height data —
a stretched voxel column simply had more height than a bare one, and the same heightfield
that got rendered was implicitly what determined whether a lower-height object behind it
was occluded. Render and gameplay were unified because both consumed the same heightfield.

The two-layer hybrid renderer in `03-terrain-and-grass-rendering-design.md` intentionally
reintroduces this unification: **both the relief-mapped grass slab and the concealment
system described here read the same underlying grass-height texture.** This matters
because it means concealment correctness never depends on which visual LOD tier is
currently active, whether the near-field compute blade layer has thinned a given blade at
a crossfade boundary, or which rendering backend (WebGPU/WebGL2) is in use. Concealment is
computed from authored data, not from what happened to get drawn on screen.

## 3. Data source

A single world-space texture, `grassHeightField`, built during the asset pipeline from the
extracted detail map + detail elevation strip (see `02-asset-format-specification.md`
§5). Resolution should match or slightly exceed the detail-map's native resolution — no
need to match full heightmap/colormap resolution, since grass-height detail coarser than
that is not perceptible for concealment purposes.

Each texel encodes: `grassTopHeight(x, z) = terrainHeight(x, z) + grassStretchAmount(x, z)`,
i.e. an absolute world-space height, not a relative offset — simplifies the line-of-sight
math in §4.

## 4. Line-of-sight / concealment query

Given an observer position `O` and a target position `T` (e.g. a prone player's
eye/body-representative point):

1. Step along the world-space segment `O → T` at a fixed sample interval (tune for
   accuracy vs. cost — start with ~1–2m steps, refine if sniping ranges show
   false-negatives/positives near grass edges).
2. At each sample point `P`, compute the sightline height at that point (linear
   interpolation of the `O.height → T.height` ray) and compare against
   `grassHeightField(P.x, P.z)`.
3. If the sightline height at any sample point is **below** the grass height at that
   point, the line of sight is blocked — `T` is concealed from `O` at this instant.
4. Concealment is therefore a per-observer, per-target, per-frame (or per-tick, if
   throttled) boolean, driven entirely by texture lookups along a line — no scene raycast
   against renderable geometry required.

### 4.1 Cost

A handful of texture samples per query (segment length / step interval). For an 800m
sightline at 2m steps, that's 400 samples — trivial on CPU even without GPU involvement,
and can be pushed to a compute shader for batched multi-observer/multi-target queries (AI
squads checking visibility against many potential targets per tick) if profiling shows it
matters.

### 4.2 Player state input

Concealment queries need a per-entity "effective height" that reflects stance:
- Prone: use a low height value (near-ground) at the target's `(x, z)`.
- Crouched: intermediate height.
- Standing: full eye-height — likely exceeds most grass-top heights, so standing players
  are concealed only in exceptionally tall grass zones, matching original game behavior
  (grass concealment favored prone/crouched play).

This stance-to-height mapping is a small gameplay-tuning table, not derived from any
extracted asset data.

## 5. Interaction with rendering

The renderer (`03-terrain-and-grass-rendering-design.md`) and this concealment system are
independent consumers of the same `grassHeightField` texture but must not be coupled
beyond that shared data source:

- The renderer is free to simplify/LOD/crossfade its visual representation of grass
  however performance requires.
- The concealment system always queries the authored field directly, regardless of what's
  currently drawn.
- This means it is possible (and correct) for a target to be concealed even in a frame
  where, say, the near-field compute-blade layer has momentarily thinned blades at a
  crossfade boundary near the target — visually this reads fine because the relief-mapped
  far layer (§4.1 of the rendering doc) is what's actually providing coverage at any
  distance beyond ~15–20m, which is where most 800m-class engagements are happening
  anyway.

## 6. Edge cases to handle

- **Grass edges / zone boundaries**: a target standing exactly at a grass-to-bare-ground
  boundary — expected to be a fair, visually-legible concealment loss, not a hard cliff;
  consider a small tolerance/hysteresis band to avoid flicker in concealment state as a
  target moves near a boundary.
- **Terrain occlusion vs. grass occlusion**: this system only handles grass; a separate
  (standard) terrain-heightfield or geometry raycast is still needed for hard terrain/hill
  occlusion. The two checks are complementary — either one blocking line-of-sight is
  sufficient to conceal.
- **Multiple grass "layers" (unlikely but worth flagging)**: if any DF2 terrain data turns
  out to encode more than one grass height band per texel (e.g. bushes above short grass),
  the single-height-per-texel model here will need extending — resolve once real terrain
  data is inspected.

## 7. Open implementation questions

- Sample interval tuning for the line-of-sight walk (§4) — balance accuracy at grass edges
  against per-query cost, especially for AI squads running many concurrent queries.
- Whether to expose concealment as a continuous "concealment %" (e.g. partial cover at
  grass edges, softer than a hard boolean) rather than a strict boolean, for a slightly
  more forgiving/realistic feel than the original.
