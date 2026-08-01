# Authoritative aim sway design

## Goal

Weapon sway is gameplay, not decoration. A player following the reticle must hit
the point indicated by that reticle. Stance and breath control must change both
the visible motion and the authoritative shot direction.

## Rejected splits

Keeping sway only on the weapon model makes the scope lie: reticle and impact
diverge by metres at long range. Applying separate procedural functions to
gameplay and presentation eventually creates the same disagreement through
timing or parameter drift. Filtering mouse input to imitate steadiness conflates
player control with character condition.

## Shared controller

One mutable `AimSwayController` owns phase, breath stabilization, angular yaw
and pitch, and small weapon-position offsets. It updates once per frame before
shot events are drained. Its angular output rotates the base camera direction to
produce `AuthoritativeAimState`; the same output rotates the weapon rig and scope
capture. The rangefinder and trajectory debug therefore query the shot direction
that the reticle actually indicates.

Angular amplitude transitions from hip to ADS and is multiplied by stance:

| Stance | Multiplier | Intent |
|---|---:|---|
| stand | 1.00 | unsupported, strongest motion |
| crouch | 0.62 | braced body, moderately steadier |
| prone | 0.30 | supported position, substantially steadier |

Holding Shift while ADS smoothly increases breath stabilization. At full hold,
sway amplitude is multiplied by `0.24`. There is no stamina duration in this
slice; a later `PlayerCondition` system can gate the same stabilization input.

## Scan and precision input

Normal ADS uses FOV-scaled scan sensitivity so a player can sweep for targets.
Holding Shift blends to the configured sniper precision multiplier while also
stabilizing sway:

```text
scan = baseSensitivity * opticFovRatio
precision = scan * precisionScale
scoped = lerp(scan, precision, breathStabilization)
effective = lerp(baseSensitivity, scoped, adsBlend)
```

At the default 5.5° optic and 1,300 m, scan mode is approximately 6.5 cm per
mouse count and held-breath precision is 1.6 cm. The transition uses the same
damped breath value as sway, so pressing or releasing Shift cannot snap aim.

## Frame order

```text
consume input
update weapon ADS state
update ADS presentation blend
update authoritative sway from ADS + stance + breath
derive authoritative aim direction
drain shot events against that aim
render weapon and scope from the same sway output
```

Tests cover deterministic phase motion, stance ordering, breath reduction,
hitch clamping, scan/precision sensitivity endpoints, and continuous blends.
