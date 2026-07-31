# Long-range mouse aim design

## Problem and correct acceptance range

Pointer lock removed hold-to-drag aiming but retained the old drag sensitivity of
`0.0032` radians per mouse count. Pointer deltas commonly arrive in whole counts,
so that value produces a 4.16 m angular step at 1,300 m. The existing 140 m
target ladder came from a grass-concealment test; it is not an acceptable aiming
benchmark for a DF2-derived sniper system.

The human acceptance range is 1,300 m. A one-count movement through the default
optic must move the aim by no more than 5 cm at that range. The weapon query
range and target harness must both reach beyond 1,300 m.

## Considered approaches

An arbitrarily smaller global multiplier improves the optic but makes hip turning
needlessly slow and breaks again when magnification changes. Interpolating camera
rotation across frames only hides steps, adds latency, and cannot create input
precision. Neither is acceptable.

Use raw pointer input when the browser supports it, with normal pointer lock as a
fallback. Apply FOV-aware sniper scaling to a configurable base sensitivity:

```text
opticRatio = tan(opticFov / 2) / tan(mainFov / 2)
scopedSensitivity = baseSensitivity * opticRatio * precisionScale
effectiveSensitivity = lerp(baseSensitivity, scopedSensitivity, adsBlend)
```

Defaults are `0.0016` radians/count for hip input and `0.25` for the sniper
precision scale. Query parameters `mousesens` and `scopesens` allow human tuning
without a rebuild. The existing damped optic presentation value supplies
`adsBlend`, so sensitivity changes continuously through ADS. Variable optic FOV
is read live, making Z/X zoom affect control resolution as well as magnification.

At 1,300 m the expected one-count lateral steps are approximately:

- default optic, 5.5° FOV: 4.3 cm;
- narrow optic, 2.5° FOV: 2.0 cm;
- wide optic, 9° FOV: 7.1 cm.

This gives roughly 12 mouse counts across a 0.5 m torso at the default optic and
25 at maximum magnification. The HUD reports the live centimetres-per-count value
at 1,300 m so the precision contract is directly observable.

## Ownership and data flow

A small mutable `LookSensitivityController` lives beside the FPS core
controllers. `DF2Scene` creates one instance. `WeaponPrototype` writes the live
optic FOV and ADS presentation blend each frame; `FlyControls` reads radians per
count when consuming pointer-lock deltas. No React render occurs on mouse move.

`CombatTelemetry` publishes the derived 1,300 m diagnostic at low frequency.
The current sniper hitscan range is extended beyond the acceptance range, and
the test-target harness gains long-range figures through 1,300 m.

## Verification

Pure tests cover hip, default/min/max optic values, ADS blend endpoints, query
configuration validation, and the 5 cm default-optic acceptance bound at 1,300 m.
Human verification uses the 600 m, 1,000 m, and 1,300 m targets: one-count
movements must be fine-grained, ADS transitions must not jump, and changing
magnification must change sensitivity in the same direction as visible zoom.
