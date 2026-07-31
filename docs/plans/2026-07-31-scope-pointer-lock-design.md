# Scope pointer-lock design

## Goal

Scope mode should behave like an FPS: once the canvas has captured the pointer,
mouse movement rotates aim continuously without holding a button. Browser
security still requires one user gesture to enter pointer lock.

## Behavior

- In `?scene=scope`, the first left or right canvas press requests pointer lock.
- The first left press used to capture the pointer does not fire a shot.
- Once locked, raw mouse deltas drive the existing yaw/pitch camera rig. Left
  press fires and right press toggles ADS.
- Escape releases the pointer through the browser's standard behavior.
- Terrain, benchmark, and weapon-inspection modes keep drag-to-look.
- Losing focus clears movement keys and any drag state.

`FlyControls` owns look/capture behavior; `WeaponPrototype` only rejects a
trigger press when scope mode has not captured the pointer. This keeps gameplay
input from owning camera implementation details.

## Trajectory semantics

The current solver is hitscan, so its resolved path is exactly straight and its
flight time, drop, and drift are zero. The HUD labels this explicitly. The debug
view must not draw cosmetic curvature: a later fixed-step ballistic solver will
emit the actual curved sample points through the same `ShotTrace` contract.

## Verification

Enter scope mode, click once to capture, and confirm mouse movement aims without
holding a button. Confirm the capture click consumes no ammo, subsequent left
clicks fire, right click still toggles ADS, Escape releases the pointer, and
non-scope terrain mode still requires dragging. A current shot should be labeled
`hitscan` and remain straight.
