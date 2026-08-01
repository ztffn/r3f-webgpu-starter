# FPS module contracts

For the full as-built module map, performance boundaries, human acceptance
checklist, and deliberately deferred work, start with
[`docs/10-fps-combat-implementation-spec.md`](../../docs/10-fps-combat-implementation-spec.md).

The detailed trigger-to-impact contract, formulas, modifier seams, and failure
budgets are in
[`docs/11-weapon-ballistics-and-modifier-system-spec.md`](../../docs/11-weapon-ballistics-and-modifier-system-spec.md).
The attachment/perk implementation sequence is in the
[`weapon-ballistics modifier roadmap`](../../docs/plans/2026-08-02-weapon-ballistics-modifier-roadmap.md).

`src/fps` is a local-first gameplay slice, not a general ECS or game framework.
Mutable systems own gameplay truth; React Three Fiber components adapt that
truth to cameras, GLBs, mixers, materials, and HUD snapshots.

## Data flow

```text
DOM input
  -> LocalPlayerController ordered WeaponCommand edges
  -> LoadoutSystem / WeaponSystem
  -> accepted shot event
  -> BallisticProjectileSystem (120 Hz gravity / drag / wind)
  -> swept WorldQuery segments
  -> surface penetration + Damageable + ImpactEvent + TargetHitReport + ShotTrace
  -> CombatTelemetry + shot debug presentation
  -> weapon presentation / target presentation / HUD
```

The existing `FlyControls` remains the temporary camera motor. Each frame its
camera pose is copied into `LocalPlayerController`; gameplay code does not read
the weapon mesh, optic, or character bones.

`CompositeWorldQuery` keeps gameplay collision independent of rendering. Terrain
segments are solved analytically against the canonical CPU heightfield;
`ThreeWorldQuery` spatially indexes only explicitly registered simplified
colliders. Terrain meshes, grass shells, LODs, materials, and camera-facing
shader proxies are never raycast. The scope rangefinder and ballistic system
share the composite contract, but the rangefinder remains a straight optical
measurement.

Every accepted shot produces a `ShotTrace`. Damageable hits additionally produce
a `TargetHitReport` containing target identity, world-space impact data, range,
damage, and health before/after. Presentation reads these records and never
repeats the gameplay query.

## Aim coordinate contract

`AuthoritativeAimState` is an unclamped world-space origin and unit direction
after base mouse look and deterministic gameplay sway are composed. Shooting,
scope capture, rangefinding, targeting indicators, and future network
serialization read this form only; none derive aim from presentation bones.

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

`?scene=scope` mounts a development loadout: 1 equips the semi-auto sniper, 2
equips the semi/burst M4, 3 equips the semi-auto 9 mm Glock, and 4 equips the
semi/automatic 900 RPM SAW. B cycles each definition's authored mode order.
Click the canvas once to capture the pointer;
that capture click does not fire. Mouse movement then aims without holding a
button, Escape releases it, left mouse down/up sends trigger edges, and right
click toggles ADS. Shift boosts movement and, while ADS is active, also holds
breath; firing remains available while moving or sprinting. R reloads, and T
resets targets. Blur, pointer-lock loss, and teardown release held-trigger state.

All selectable weapons currently use the same clearly labelled
`testmodels/fps_rig.glb` proxy. Gameplay definitions contain no asset URL or
GLTF animation indices; `presentation/WeaponPresentationDefinition.ts` owns
model selection and maps fire/reload to source segments 5/4. Replacing a proxy
is therefore presentation configuration rather than a gameplay schema change.
Use `&weaponanim=1` with `?scene=weapon` to enable direct segment inspection on
keys 1–8 without conflicting with scope-scene equipment controls.

Weapon commands are plain serializable data: trigger down/up, select fire mode,
reload, and numeric equip slot. Semi fires only on a down edge, an accepted
three-round burst completes after release, and automatic fire advances every
cadence boundary crossed by the bounded simulation interval. Reload, switching,
and mode changes cancel incomplete bursts; switching also cancels reload rather
than pausing it on an unequipped weapon. Mode changes preserve cooldown, and an
empty automatic weapon emits one dry-fire event per press.

Spread and recoil are authoritative weapon state. Each definition separately
authors mechanical dispersion, hip/movement/airborne handling error, bounded
bloom, pitch/yaw recoil, caps, and recovery. Stance, measured planar speed
(including a bounded extra sprint penalty),
grounded state, ADS, and breath stabilization resolve into the cone; going prone
does not erase a weapon's mechanical grouping limit. Every accepted shot samples
that cone from a deterministic weapon-instance seed and shot sequence, captures
the recoil left by earlier rounds, and only then applies its own recoil/bloom for
later rounds. Recovery advances at cadence boundaries, including when several
automatic rounds are accepted in one render frame or while a weapon is reloading
or unequipped.

The hipfire crosshair projects the current mean sight direction and expands to
the current cone radius. It is presentation feedback only and never chooses a
shot direction. Its SVG attributes read a mutable presentation snapshot without
causing frame-rate React/HUD updates; it fades during ADS and hides outside
pointer lock. Use `&crosshair=0` to disable it. Future attachments can resolve to
the existing flat dispersion/recoil/bloom/recovery/sway modifier channels, but
attachment slots and inventory remain out of scope.

While pointer-locked and ADS, Arrow Up/Down select an ammunition-calibrated
elevation zero, Arrow Left/Right apply manual 0.1 mrad windage clicks, and 0
resets both turrets. The default .308 profile spans 100–1,300 m; slower
diagnostic profiles expose only zeros they can reach within the weapon's flight
lifetime. Page Up/Down mirror elevation on full keyboards. Matching keydown
events are consumed only in that scope context; keyup remains available to
clear the arrow-key movement fallback. Z/X continue to control magnification.

Pointer-lock sensitivity is FOV-scaled through the live ADS transition and
variable optic zoom. At 1,300 m the default optic resolves to roughly 6.5 cm per
count while scanning and 1.6 cm while Shift stabilizes breath; the HUD publishes
the live value. Slow input stays linear, while a bounded curve accelerates large
scan movements and fades out during breath hold. Use `mousesens`, `scopesens`,
and `aimcurve` to override base radians/count, held-breath precision scale, and
extra scan boost (defaults: `0.0006`, `0.25`, and `1.25`; zero curve disables
acceleration). The target harness extends to 1,300 m and the prototype sniper
query range is 2,000 m.

Sway is authoritative gameplay aim. Stand, crouch, and prone use multipliers
`1.0`, `0.62`, and `0.30`; Shift while ADS smoothly reduces both sway and mouse
sensitivity. The scope picture, rangefinder, shot, and trace share that result.

Add `&shotdebug=1` to draw the latest resolved shot in world space. The cyan
screen-space-width line is the shot path, the white segment is initial
authoritative aim, and red marks the impact and surface normal. The wider debug
line remains legible when viewed nearly end-on at gameplay ranges. The HUD
retains a short recent-shot log.
Press L to clear the current debug trace.

Accepted weapon events use active 120 Hz ballistic projectiles. The sniper's
792.48 m/s, G1-0.505 prototype ammunition is affected by gravity, drag, and
world-space wind; damage is delayed until a swept path segment actually reaches
a target.
The default wind is +4 m/s on world X. Use `windx` and `windz` query parameters
for controlled tests, including `&windx=0` for still air and `&windx=-4` for an
equal opposite crosswind. Flight time, drop, signed drift, impact speed, damage,
HUD telemetry, and trajectory debug all come from the resolved simulation.
The optic displays the current zero and signed windage inside the lens. Its
reticle/rangefinder use the optical sightline, while the projectile launches
along the turret-adjusted bore direction. Debug draws the sightline white and
the bore direction yellow before the cyan resolved path.

The projectile core uses a 2,048-slot typed-array pool and performs no
per-projectile allocations inside a fixed step. Automated authority-core loads
cover 16/32 shooters at 600 RPM and 32 shooters at 900 RPM using the analytic
heightfield, spatially indexed colliders, hits, and misses. This proves the
bounded projectile/query workload, not an entire 32-player rendered/networked
match; character, network, audio, and GPU acceptance still requires a browser
benchmark on target hardware. Each weapon also authors a finite maximum flight
lifetime, so a slow missed round cannot occupy a slot indefinitely.

Weapon-layer coverage separately instantiates 32 complete loadouts, depletes
automatic magazines, drains all real weapon events, completes reloads, and
resumes fire at both 600 and 900 RPM. Equivalent timelines at 30, 60, and 144 Hz
must produce identical shot offsets, final recoil/bloom, ammo, dry-fire, and
reload outcomes. The test uses independent shooter seeds, retains only rolling
direction checksums, and reports CPU time without a machine-specific millisecond
assertion.

## Surface penetration and impacts

World-query registrations now carry an explicit gameplay surface and authored
simplified-collider thickness. Three.js visual material names never determine
cover behavior. The fixed-step projectile compares its remaining energy against
surface resistance adjusted for incidence angle. A penetrating round loses
speed, emits authoritative entry/exit data, advances beyond that collider, and
continues as the same pooled projectile. It does not spawn a second hitscan ray.

Surface profiles cover cloth, wood, sheet metal, armored metal, stone, dirt,
flesh, water, and glass. `WorldObjectPrefab` composes a procedural visual,
simplified box collider, optional health, and one intact-to-husk transition;
objects without health still produce material impacts. This is a small prefab
runtime, not an ECS.

Impact presentation subscribes to completed gameplay contacts. Visual debris
uses one 384-slot instanced draw. Spatial sound uses 24 positional Web Audio
voices with prebuilt procedural surface variants, distance culling, and bounded
voice stealing. A local hit marker is published at contact time even when the
projectile penetrates and remains in flight.

Open `?scene=scope&impacttest=1&shotdebug=1` for eight cover lanes, ordered left
to right: cloth, wood, sheet metal, armored metal, glass, stone, dirt, and water.
Each has a resettable flesh target behind it. Choose representative diagnostic
ammunition with `ammo=9mm`, `ammo=556`, `ammo=308` (default), or `ammo=50bmg`.
The proxy sniper GLB remains mounted for all four because authored per-weapon
presentation does not exist; the URL changes the sniper slot's diagnostic
ammunition data, not the displayed gun. The selectable Glock definition uses
9 mm by default, while `ammo=9mm` still overrides the sniper slot for ballistic
diagnostics.
The first canvas press also unlocks spatial audio. T resets the target husks.

Shot debug keeps the cyan gameplay path, white sightline, and yellow bore.
Surface entries are orange, exits green, and stops red. HUD contact telemetry
reports ammunition, surface, outcome, effective thickness, and speed before and
after. Automated coverage includes 32 shooters at 900 RPM with one cloth impact
per round; projectile slots and impact-event queues remain bounded.

Out of scope here: saved/custom keybindings, in-game ammunition/loadout
selection, decals, ricochet, layered armor, projectile deformation, physics
movement, stamina, attachments, networking, bot presentation, and remote tracer
presentation.
