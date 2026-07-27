# 04 — Concealment System Design

The gameplay counterpart to the grass renderer (`03-...md` §4). DF2's defining tactical
property is that tall grass genuinely conceals — a prone soldier can be invisible at long
range yet the grass is fully traversable. This document specifies how concealment is
computed **independently of what the GPU happens to draw**.

---

## 1. Core principle: decouple gameplay from rendering

Rendering grass and *resolving whether one entity can see another through grass* are
different problems with different correctness requirements:

- The renderer may LOD-out, fade, or cull grass for performance — none of that must change
  whether a target is concealed.
- Concealment must be deterministic and identical regardless of camera position, resolution,
  or graphics settings (critical the moment this becomes multiplayer-capable, even though
  networking is a v1 non-goal).

Therefore concealment reads from a **gameplay heightfield + cover field** sampled on the CPU
(or a compute pass dedicated to gameplay), never from the render meshes.

The scaffold already honors this: `src/df2/Heightfield.js` is a standalone CPU sampler with
its own bilinear `sample()` and analytic `normal()`, deliberately not derived from the
render geometry. It is the seed of the gameplay heightfield described here.

---

## 2. Fields

Two co-registered 2D fields over the world, at the terrain's native resolution:

1. **Ground height** `H(x, z)` — bare terrain elevation (the heightmap). Already present.
2. **Cover height** `C(x, z)` — top of the concealing grass canopy above ground at that
   texel, derived from detail-map material × detail-elevation strip (`02-...md` §4). `C = 0`
   on bare/sand/rock, `C > 0` (up to ~1.5–2 m) in tall-grass zones.

Optionally a scalar **cover density** `D(x, z) ∈ [0,1]` for partial concealment (thin grass
attenuates rather than fully blocks).

---

## 3. Line-of-sight query

`canSee(observer, target)` — the fundamental query — is a segment march over the fields:

```
march the 3D segment observer -> target in steps of ~1 texel:
  at each sample point p:
    groundTop = H(p.xz)
    coverTop  = groundTop + C(p.xz)
    if p.y < groundTop:        return BLOCKED   (ray went into the hill -> terrain LOS block)
    if p.y < coverTop:         accumulate occlusion += D(p.xz) * stepLen
  if accumulatedOcclusion >= CONCEAL_THRESHOLD:  return CONCEALED
  return VISIBLE
```

- **Terrain blocking** and **grass concealment** fall out of the same march.
- With binary cover (`D = 1`) it reduces to "is any sample of the segment below the canopy
  and above ground" → the classic DF2 "prone in grass = invisible" behavior.
- With density accumulation it supports partial cover and gives smooth "how hidden am I"
  values for AI awareness rather than a hard boolean.

### 3.1 Stance matters

Concealment is a function of the **eye/target height above ground**, i.e. stance:

| Stance | Eye height above ground | Concealed by ~1.2 m grass? |
| --- | --- | --- |
| Prone  | ~0.3 m | yes, even at long range |
| Crouch | ~0.9 m | partially |
| Stand  | ~1.6 m | no (head above canopy) |

The march compares the segment's height at each sample to `coverTop`, so lowering stance
lowers the segment and pushes more of it under the canopy — exactly the original's behavior,
emergent rather than special-cased.

---

## 4. AI perception hook

AI does not read pixels. Each perception tick, an AI agent issues `canSee(self, playerEye)`
(and vice-versa for the player's "am I spotted" feedback). The tri-state result
(`BLOCKED / CONCEALED / VISIBLE`) plus accumulated occlusion feeds the agent's detection
meter:

- `VISIBLE` → detection rises fast (scaled by range/lighting).
- `CONCEALED` → detection rises slowly or decays (target is in cover).
- `BLOCKED` → detection decays (no LOS at all).

This makes "go prone in the tall grass to break contact" a real, systemic tactic rather than
a scripted animation.

---

## 5. Performance & data source

- The fields are small (terrain-resolution 2D arrays); `sample()` is O(1) bilinear.
- A LOS march is a few hundred samples worst-case; fine for the handful of AI↔player queries
  per tick. Batch/stride and early-out on the first terrain block.
- Cover field `C` is built once per map at load: for each texel, look up its detail-map
  material index, map that to a canopy height via the detail-elevation strip. Until the real
  mapping is confirmed (`01-...md` §7), the scaffold can synthesize `C` from the same noise
  domain as the render grass so gameplay and visuals agree.

---

## 6. Integration order

1. **Now (done):** CPU heightfield sampler exists and is decoupled (`Heightfield.js`).
2. **Phase 2:** author the cover field `C`/`D` alongside the render grass so both read the
   same density source.
3. **Phase 3:** implement `canSee()` + stance + the tri-state result.
4. **Phase 4:** wire `canSee()` into the AI perception loop and the player's spotted-state UI.
