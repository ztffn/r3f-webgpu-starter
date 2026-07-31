# Local-first FPS scaffold

## Goal and boundary

Turn the existing sniper/scope prototype into a small playable local combat
slice without introducing an ECS, physics controller, ballistics, networking,
or renderer refactor. High-frequency truth lives in mutable TypeScript systems
updated from `useFrame`; React mounts presentation and publishes low-frequency
telemetry only.

The branch owns `src/fps/**` and only additive scene/HUD wiring. It does not
change terrain geometry, terrain or grass materials, grass tuning, or world
render setup. The existing `WeaponPrototype` remains the first-person host so
its ADS, picture-in-picture scope, sway, hold-breath, camera layers, and render
order survive this pass.

## Architecture and data flow

`LocalPlayerController` captures discrete combat commands and owns a mutable
world-space `AuthoritativeAimState`. For this transitional slice it synchronizes
position, stance, and aim from the existing camera motor instead of replacing
`FlyControls`. Shooting always copies the undamped authoritative ray before any
presentation recoil is applied.

`LoadoutSystem` owns generic slots and delegates runtime behavior to the
equipped `WeaponSystem`. A data-only `WeaponDefinition` supplies magazine,
reserve, cadence, reload, ADS, recoil, animation, and hitscan settings. The
weapon accepts a click only when equipped, loaded, off cooldown, and not
reloading; it emits shot, reload, dry-fire, ADS, and recoil events.

Each accepted shot flows through `HitscanResolver` to the shared `WorldQuery`.
The Three.js adapter raycasts only explicitly registered world roots, labels
hits as terrain or target, and associates target roots with a `Damageable`.
This same query supplies the scope rangefinder, preventing two subtly different
raycast implementations. A miss is normal, missing optional terrain is safe,
and unregistering a root removes it immediately.

`CombatTelemetry` exposes immutable snapshots to the HUD at event/state-change
frequency. It never raycasts. First-person presentation consumes weapon events
for animation/recoil while the already-resolved shot direction remains fixed.

## Character aim rig

`AuthoritativeAimState` remains undamped world gameplay truth.
`CharacterAimPresentationAdapter` converts it to root-local radians using world
up and a documented authored forward axis. `AimRig` touches procedural bones
only and follows the required lifecycle:

```text
aimRig.beginFrame()
mixer.update(dt)
aimRig.update(dt)
```

The rig caches pure animated quaternions, damps only procedural offsets,
converts root-space deltas into each bone's parent space, walks root to leaf,
and publishes residual yaw. It has primitive zero-allocation setters and no
camera, bot, network, or gameplay references. This pass supplies the module and
focused deterministic coverage; character GLB selection, bot harness, live GUI,
and browser profiling remain a presentation/benchmark follow-up because no
production third-person character host exists yet.

## Playable slice and controls

`?scene=scope` gains one primary sniper, one hitscan ray per accepted left
click, ammo/cooldown/dry-fire/reload, right-click ADS, Shift breath hold while
aiming, and R reload. Debug action keys `1`–`8` remain available. Test targets
are enabled for the scope slice and implement resettable health with a visible
hit flash; the existing `?targets=1` contrast mode still works.

The HUD reads combat snapshots for ammo, weapon phase, hit marker, damage, and
range. It continues to treat all panels as development instrumentation, not
final player UI.

## Verification

Pure systems receive deterministic tests for fire cadence, ammo, dry fire,
reload, loadout switching, nearest-hit resolution, damage/reset, aim conversion,
yaw wrapping, state gating, hitch clamping, and non-accumulating aim offsets.
Repository verification remains `npm run typecheck` and `npm run build`. The
full 32/64-character median/p95 browser benchmark and allocation-profiler run
belong with the future character presentation harness rather than being faked
without mounted character assets.
