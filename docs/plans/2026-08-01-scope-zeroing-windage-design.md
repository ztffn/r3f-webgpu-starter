# Scope zeroing and windage design

## Goal

Make authoritative drop and wind usable from compact PC/Mac keyboards without
turning the scope into an automatic ballistic computer. Elevation and windage
are manual player inputs. Their state is visible inside the optic, while the
general HUD remains debug telemetry.

## Sight and bore contract

Zeroing introduces two different authoritative directions:

- **Sight direction** is the centre of the reticle. Scope capture and the
  optical rangefinder use it.
- **Bore direction** applies the selected elevation zero and manual windage
  angle to the sight direction. Projectile simulation launches along it.

The ballistic path, collision, damage, and trace still come from one projectile
simulation. Magnification changes neither direction nor turret state.

Elevation zero is ammunition-driven. For each selectable distance from 100 to
1,300 m, a deterministic predictor uses the same fixed-step gravity and drag
kernel as live projectiles in still air, then solves the positive bore elevation
that crosses the sightline at that distance. Wind is not corrected
automatically. Windage is a signed manual adjustment in 0.1 mrad clicks.

## Laptop-safe bindings

Bindings are interpreted only while the canvas owns pointer lock and ADS is
wanted:

- Arrow Up / Arrow Down: next/previous 100 m elevation zero;
- Arrow Left / Arrow Right: one 0.1 mrad windage click left/right;
- Page Up / Page Down: secondary elevation bindings for full PC keyboards;
- Digit 0: reset to 100 m and zero windage;
- Z / X: retain variable magnification.

Ignore `keydown` repeat so one press is one click. Consume matching keydown
events in capture phase to prevent browser scrolling and prevent the existing
arrow movement fallback from also firing. Do not consume keyup; `FlyControls`
must always be able to clear a held movement key. Bindings use
`KeyboardEvent.code` and are centralized for later rebinding.

## In-optic UI

A small transparent scope-status texture is composited with the existing lens
capture and reticle. It displays the selected elevation zero and signed
windage as unboxed black text on two rows at the lower-right of the optic, for
example:

```text
ZERO 600 M
WIND L 1.2
```

The texture redraws only when a turret changes. It does not enter React state or
the frame loop. The external HUD may repeat detailed values for diagnostics,
but the scope texture is the player-facing source.

## Debug trajectory

Trajectory debug distinguishes all three relevant lines:

- white: reticle sightline;
- yellow: turret-adjusted bore direction;
- cyan: actual gravity/drag/wind path;
- red: resolved impact and normal.

This makes a miss attributable to sight placement, turret adjustment, wind,
sway, or collision without recomputing gameplay in presentation.

## Verification

- Every 100–1,300 m still-air elevation preset crosses the sightline within a
  small deterministic tolerance.
- One windage click changes bore azimuth by exactly 0.1 mrad; left/right are
  symmetric and reset returns both turrets to their defaults.
- Magnification does not alter sight, bore correction, or selected zero.
- Arrow keys adjust only while pointer-locked and ADS, never move the player in
  the same keydown, and keyup remains available to movement cleanup.
- Scope readout, debug sight/bore lines, projectile launch, impact, and HUD
  telemetry all report the same controller state.
