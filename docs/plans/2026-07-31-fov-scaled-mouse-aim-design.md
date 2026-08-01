# Long-range mouse aim design

## Problem and correct acceptance range

Pointer lock removed hold-to-drag aiming but retained the old drag sensitivity of
`0.0032` radians per mouse count. Pointer deltas commonly arrive in whole counts,
so that value produces a 4.16 m angular step at 1,300 m. The existing 140 m
target ladder came from a grass-concealment test; it is not an acceptable aiming
benchmark for a DF2-derived sniper system.

The human acceptance range is 1,300 m. Normal ADS must support useful target
scanning, while held-breath precision must resolve below 2 cm per count through
the default optic. The weapon query range and target harness must both reach
beyond 1,300 m.

## Considered approaches

An arbitrarily smaller global multiplier improves the optic but makes hip turning
needlessly slow and breaks again when magnification changes. Interpolating camera
rotation across frames only hides steps, adds latency, and cannot create input
precision. Neither is acceptable.

Use raw pointer input when the browser supports it, with normal pointer lock as a
fallback. Apply FOV-aware sniper scaling to a configurable base sensitivity:

```text
opticRatio = tan(opticFov / 2) / tan(mainFov / 2)
scanSensitivity = baseSensitivity * opticRatio
precisionSensitivity = scanSensitivity * precisionScale
scopedSensitivity = lerp(scanSensitivity, precisionSensitivity, breathBlend)
effectiveSensitivity = lerp(baseSensitivity, scopedSensitivity, adsBlend)
```

Defaults are `0.0006` radians/count for hip input (roughly 33 cm/360° at 800 DPI
with raw input) and `0.25` for the sniper precision scale. Query parameters
`mousesens` and `scopesens` allow human tuning
without a rebuild. The existing damped optic presentation value supplies
`adsBlend`, so sensitivity changes continuously through ADS. Variable optic FOV
is read live, making Z/X zoom affect control resolution as well as magnification.
Slow deltas remain linear; a bounded scan curve accelerates larger deltas and
fades out as breath stabilization engages.

At 1,300 m the expected scan / held-breath one-count steps are approximately:

- default optic, 5.5° FOV: 6.5 / 1.6 cm;
- narrow optic, 2.5° FOV: 3.0 / 0.7 cm;
- wide optic, 9° FOV: 10.6 / 2.7 cm.

This gives roughly 31 mouse counts across a 0.5 m torso at the default optic and
68 at maximum magnification. The HUD reports the live centimetres-per-count value
at 1,300 m so the precision contract is directly observable.

## Ownership and data flow

A small mutable `LookSensitivityController` lives beside the FPS core
controllers. `DF2Scene` creates one instance. `WeaponPrototype` writes the live
optic FOV and ADS presentation blend each frame; `FlyControls` reads radians per
count when consuming pointer-lock deltas. No React render occurs on mouse move.

`CombatTelemetry` publishes the derived 1,300 m diagnostic at low frequency.
The current sniper hitscan range is extended beyond the acceptance range, and
the test-target harness gains long-range figures through 1,300 m.

The scope capture, rangefinder, and shot resolver must share the authoritative
aim direction, including gameplay sway. The weapon presentation consumes that
same sway result rather than running a second cosmetic approximation.

## Verification

Pure tests cover hip, default/min/max optic values, ADS blend endpoints, query
configuration validation, and the 5 cm default-optic acceptance bound at 1,300 m.
Human verification uses the 600 m, 1,000 m, and 1,300 m targets: one-count
movements must be fine-grained, ADS transitions must not jump, and changing
magnification must change sensitivity in the same direction as visible zoom.
