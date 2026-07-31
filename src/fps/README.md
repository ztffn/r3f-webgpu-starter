# FPS module contracts

`src/fps` is a local-first gameplay slice, not a general ECS or game framework.
Mutable systems own gameplay truth; React Three Fiber components adapt that
truth to cameras, GLBs, mixers, materials, and HUD snapshots.

## Data flow

```text
DOM input
  -> LocalPlayerController
  -> LoadoutSystem / WeaponSystem
  -> accepted shot event
  -> HitscanResolver
  -> WorldQuery
  -> Damageable + TargetHitReport + ShotTrace
  -> CombatTelemetry + shot debug presentation
  -> weapon presentation / target presentation / HUD
```

The existing `FlyControls` remains the temporary camera motor. Each frame its
camera pose is copied into `LocalPlayerController`; gameplay code does not read
the weapon mesh, optic, or character bones.

`ThreeWorldQuery` raycasts only explicitly registered roots. Terrain is an
optional registration, so targets continue to work while the world renderer is
being changed. The scope rangefinder and hitscan resolver share this query.

Every accepted shot produces a `ShotTrace`. Damageable hits additionally produce
a `TargetHitReport` containing target identity, world-space impact data, range,
damage, and health before/after. Presentation reads these records and never
repeats the gameplay query.

## Aim coordinate contract

`AuthoritativeAimState` is an undamped, unclamped world-space origin and unit
direction. Shooting, targeting indicators, and future network serialization
read this form only.

`AimRigRenderInput` is cosmetic. Angles are radians in character-render-root
local space. The current authored character-forward convention is `+Z`;
positive yaw turns from `+Z` toward `+X`, and positive pitch looks upward. Yaw
is normalized to `[-PI, PI]` before clamping. The presentation adapter builds
the local heading against world up, so root pitch/roll on slopes does not tilt
the aim horizon. A `-Z` authored model is corrected in the adapter rather than
by changing gameplay aim.

The adapter is the sole insertion point for local, bot, or future interpolated
network aim. `CharacterAimRig` retains no scene object, camera, bot, or network
reference.

## Mandatory mixer lifecycle

Every presented character must call:

```ts
aimRig.beginFrame();
mixer.update(dt);
aimRig.update(dt);
```

`beginFrame()` restores the last pure animated quaternions. `update()` captures
the current mixer output, damps procedural offsets only, converts the root-space
delta into each bone parent's space, and pre-multiplies it exactly once. This is
required even when tested clips key every bone: future reload/hit clips may not.

Use primitive setters in the frame loop:

```ts
aimRig.setRootWorldQuaternion(q.x, q.y, q.z, q.w);
aimRig.setLook(look.yaw, look.pitch, look.weight);
aimRig.setAim(aim.yaw, aim.pitch, aim.weight);
```

`residualYaw` is render-root-local unconsumed yaw for a future turn-in-place
request. It is never applied to gameplay aim by the rig.

## Current playable slice

`?scene=scope` mounts one primary semi-auto sniper. Left click fires, right
click toggles ADS, Shift holds breath while ADS is active, R reloads, and T
resets targets. The numbered keys remain direct authored-animation inspection.

Add `&shotdebug=1` to draw the latest resolved shot in world space. The cyan
line is the shot path, the white segment is initial authoritative aim, and red
marks the impact and surface normal. The HUD retains a short recent-shot log.
Press L to clear the current debug trace.

This slice remains hitscan. Rapier is reserved for world/player physics. Future
rifle drop, wind, and drag will be integrated by a fixed-step solver using swept
`WorldQuery` segments and emitting the same `ShotTrace`/`TargetHitReport`
contracts.

Out of scope here: projectiles, spread, decals, physics movement, stamina,
attachments, networking, bot presentation, and the 32/64-character browser
benchmark harness.
