# FPS Combat Implementation Spec — as built

**Audience:** anyone resuming FPS, weapons, combat, character-aim, or related
multiplayer work without the history of the prototype sessions.

This is the canonical as-built description of `src/fps/**`. The dated files in
`docs/plans/` explain individual decisions; `src/fps/README.md` is the compact
operator reference. If a dated proposal disagrees with this document, this
document describes the current implementation. Terrain and grass remain covered
by `08-implementation-spec.md` and the terrain-specific design documents.

For the trigger-to-impact lifecycle, formulas, failure budgets, and the
attachment/perk extension contract, see
`11-weapon-ballistics-and-modifier-system-spec.md`. Its staged implementation
sequence is in
`plans/2026-08-02-weapon-ballistics-modifier-roadmap.md`.

## 1. Current result

The `?scene=scope` route is a local-first FPS combat slice built beneath the
existing animated sniper presentation. It currently provides:

- pointer-lock mouse look with FOV-aware scan/precision response;
- authoritative stance- and breath-dependent sway;
- a data-driven weapon/loadout runtime with ammunition, cadence, reload, ADS,
  semi/burst/automatic fire, dry-fire, deterministic dispersion, recoil, and
  bounded bloom/recovery;
- fixed-step gravity/drag/wind ballistics with delayed damage;
- default-.308 scope elevation zeroing from 100–1,300 m, reachable-preset
  filtering for slower profiles, and manual windage;
- analytic terrain collision plus spatially indexed simplified object colliders;
- material resistance, bounded penetration, target damage, and intact-to-husk
  object transitions;
- bounded instanced impact particles and positional impact audio;
- HUD snapshots, a truthful hipfire crosshair, hit reports, performance
  counters, and opt-in trajectory debug;
- deterministic unit/load coverage for the gameplay systems.

This is not yet a complete player, weapon library, or multiplayer match. There
is one proxy FPS rig shared by the selectable sniper, M4, Glock, and SAW, and no
in-game loadout or settings screen. Authored per-weapon models and animations
have not been added. What HAS landed since this document's first draft: the
character motor and remote-soldier presentation (docs/12), and **server-
authoritative PvP damage on the shared ballistic model** — the shared core now
lives in `src/combat/` and the authority contract is docs/11 §15.3 with the wire
in docs/12 §8.3. Damage to local world targets remains client-local.

## 2. Ownership and data flow

High-frequency gameplay truth lives in mutable TypeScript systems. React/R3F
mounts those systems, adapts them to Three.js presentation, and publishes
throttled snapshots to the HUD.

| Layer | Owns | Must not own |
| --- | --- | --- |
| `LocalPlayerController` | input commands, position, stance, planar speed, authoritative world aim | meshes, bones, scope materials |
| `AimSwayController` | deterministic gameplay sway and breath stabilization | a second cosmetic-only shot direction |
| `FiringTimeline` | one per-frame simulation timeline: sub-frame sway/projectile advance, frozen pose per accepted round, sight/bore/projectile composition | cadence decisions, input, GLTF, HUD |
| `LookSensitivityController` | FOV-scaled pointer response and scan curve | camera or React state |
| `LoadoutSystem` | slots, equipped weapon, switch state | GLTF animation details |
| `WeaponSystem` | ammunition, cadence, reload, ADS, handling context, deterministic dispersion, recoil/bloom and shot events | terrain, targets, or scope shaders |
| `BallisticProjectileSystem` | live projectile state, integration, contacts, damage, reports | rendered terrain or per-shot React objects |
| `WorldQuery` | nearest gameplay collision contract | weapons, UI, or render LOD policy |
| `Damageable` / world prefabs | health, authored surface/thickness, hit/destruction response | player input |
| presentation components | GLBs, mixers, scope PiP, particles, sound, debug lines | gameplay truth |
| `CombatTelemetry` | immutable low-frequency snapshots | raycasting or simulation |
| `WeaponAimIndicator` | mutable crosshair presentation values | accepting shots or generating spread |

```text
DOM input
  -> LocalPlayerController commands
  -> stance / speed / grounded / breath handling context
  -> weapon/loadout update queues an accepted shot event with its cadence offset
  -> FiringTimeline advances sway/projectiles to that offset
  -> pose interpolated at the offset + gameplay sway = base aim
  -> event-captured pre-shot recoil offset
  -> scope turret-adjusted mean bore
  -> event-captured deterministic dispersion
  -> spawn, then continue the timeline to the next offset
  -> pooled 120 Hz ballistic simulation
  -> CompositeWorldQuery swept segments
  -> penetration / Damageable / impact events
  -> telemetry + target/impact/debug presentation
```

Five direction concepts must remain distinct:

1. **Base sightline:** camera aim plus authoritative stance/breath sway.
2. **Mean sight direction:** base sight plus recoil remaining from earlier
   accepted rounds; the scope/crosshair shows this state for the next shot.
3. **Mean bore direction:** mean sight adjusted by elevation zero and windage.
4. **Accepted projectile direction:** mean bore plus this shot's deterministic
   mechanical/handling/bloom dispersion sample.
5. **Resolved trajectory:** the curved, wind-drifted projectile path.

A shot captures recoil before applying its own impulse, so recoil cannot
retroactively alter that shot. Later rounds—including several cadence events
drained during one render frame—use the state left by earlier rounds. Sway,
recoil, and spread are gameplay; the extra fast proxy-rig kick is cosmetic.

## 3. Frame order

`WeaponPrototype.tsx` is still the presentation host and owns the transitional
R3F frame integration. The important order is:

```text
clamp the render delta once into one simulation delta
sample player pose, planar speed, stance, grounded state, and breath
set equipped-weapon handling context
consume current input commands
update weapon/loadout cadence, reload, ADS, recoil, and bloom recovery
run the FiringTimeline over the frame's accepted events, in cadence order:
  advance sway and projectiles to the next acceptance boundary
  interpolate the player pose at that boundary
  compose sight -> turret-adjusted mean bore -> dispersed projectile direction
  spawn, then continue to the following boundary
  finally advance sway and projectiles to the end of the frame
drain impact/result events
update ADS presentation blend
derive end-of-frame mean sight direction and sync AuthoritativeAimState
update mixer, cosmetic recoil, crosshair, and presentation
render scope/world/weapon passes
```

**One clock.** Weapons, gameplay sway, and the projectile solver all receive the
same clamped simulation delta (`MAX_SIMULATION_FRAME_SECONDS`, 0.1 s, the weapon
runtime's own hitch bound). Presentation damping and the animation mixer keep the
raw render delta.

A projectile spawned this frame receives exactly the simulation time after its
own acceptance boundary, never time that elapsed before the trigger press. A
round accepted exactly on the frame edge therefore begins its flight in the
following frame. A shot captures one normalized origin/sight/bore state at that
boundary; later camera, sway, or turret motion does not bend a projectile
already in flight.

**What sub-frame pose reconstruction does and does not guarantee.** The host
only observes the camera at frame edges, so an acceptance boundary inside the
frame interpolates between the two endpoint samples. Position is linear and
therefore exact. Orientation is not, and the residual is *not* negligible for
fast combined-axis mouse movement. Measured on this tree, comparing one 30 Hz
frame against the equivalent 144 Hz frames:

| Look motion in one 33 ms frame | Direction residual |
| --- | ---: |
| single-axis (yaw only, or yaw with fixed pitch) | 3e-8 rad — floating point only |
| 5.7° yaw + 2.3° pitch (the `FLICKING` test track) | 3.3e-4 rad ≈ 0.33 mrad, 1.4 cm at 70 m |
| 20° yaw + 8° pitch | 4.8e-4 rad ≈ 0.5 mrad |
| 90° yaw + 30° pitch (a hard flick) | 3.1e-2 rad ≈ 31 mrad ≈ 6 m at 200 m |

A yaw-only path — including yaw at a fixed pitch — is a quaternion great circle,
which spherical interpolation reproduces exactly; only floating point survives.
Once both axes move, the true path bends away from the interpolated arc and the
error grows with the product of the two per-frame angles.

Interpolation is still a large improvement: without it every round in the frame
takes the end-of-frame orientation, an error equal to the *whole* frame rotation
rather than its second-order deviation. Removing the remainder requires
timestamped sub-frame pose samples from the input layer, which is deferred
(§10). Do not describe the current path as cadence-exact for arbitrary motion.

Two inputs are still sampled once per frame rather than per boundary, so they
are not bit-exact across render rates during a transition: breath stabilization
in the handling context (it only moves while ADS with breath held), and the
damped ADS rig blend, which is presentation only. Gameplay sway reads
authoritative `adsProgress` instead, so it does not depend on the damped blend
or on whether the proxy GLTF finished loading.

For third-person characters, preserve the separate mandatory lifecycle:

```ts
aimRig.beginFrame();
mixer.update(dt);
aimRig.update(dt);
```

`CharacterAimRig` is mounted (2026-08-03) inside
`presentation/CharacterView.ts`, which owns this lifecycle for the animated
soldier — the local third-person view and networked remote players both drive
it through the same `CharacterPose` data. See `character-aim-rig-spec-v2.md`
for the rig itself.

## 4. World-query contract

`CompositeWorldQuery` combines two purpose-built backends and returns the nearer
hit:

- `HeightfieldWorldQuery` traverses the canonical renderer-independent CPU
  heightfield. It solves the bilinear surface and normal without touching
  terrain meshes, grass proxies, shader materials, or LOD state.
- `ThreeWorldQuery` accepts only explicit simplified-collider registrations. It
  indexes their X/Z bounds in 32 m cells and performs Three.js narrow-phase tests
  only on candidates crossed by the ray.

Do not register the visual terrain group. `CompositeWorldQuery.register()`
rejects registrations of kind `terrain` deliberately. Render-only grass and
inside-canopy proxies must never become bullet collision.

`DF2Scene.tsx` creates one composite query from the loaded `Heightfield` and
passes it to the FPS range, targets, and weapon host. Impact effects are mounted
alongside them but consume authoritative events rather than querying the world.
This constructor call is the intended terrain/FPS seam. Terrain rendering can
change meshes, materials, grass, or LOD scheduling without changing ballistic
semantics or query cost.

Registered moving colliders must call the registration handle's `refresh()`
after their world bounds change. Large or invalid bounds fall back to the
unindexed set rather than silently disappearing.

## 5. Ballistics, penetration, and bounded cost

The projectile solver uses a fixed 1/120 s step with at most 0.25 s catch-up.
The default pool contains 2,048 typed-array slots. The hot no-contact integration
loop does not allocate a projectile object. Every weapon supplies both maximum
path length and maximum flight time; the prototype sniper uses 2,000 m and 3.5 s.

The default environment is standard gravity and a visible +4 m/s world-X
crosswind. The drag model is a documented single-coefficient G1 approximation,
not a full piecewise standard-drag table. That model can be replaced behind
`BallisticModel.ts` without changing projectile, query, or event contracts.

At a contact, remaining kinetic energy is compared with the authored surface
resistance, collider thickness, and capped incidence multiplier. A penetrating
round loses speed, emits entry/exit data, advances 2 mm beyond the simplified
collider, and continues in the same pool slot. Cost is bounded by eight surface
interactions and a 4,096-event impact queue per projectile system.

Presentation is separately bounded:

- one 384-instance impact-particle draw;
- 24 positional Web Audio voices, with distance culling and voice stealing;
- only the latest debug trajectory retained;
- five recent shot summaries retained by HUD telemetry.

Pool exhaustion and invalid spawns are rejected and counted. They are never
allowed to overwrite an active projectile. Queue overflow is also counted.

### What the performance tests prove

Automated synthetic spawn loads exercise five simulated seconds at 16 and 32
shooters at 600 RPM and 32 shooters at 900 RPM, including misses, analytic
terrain traversal, indexed colliders, and a cloth-contact stress case. They
verify bounded capacity, deterministic results, and that the gameplay query no
longer scales with the rendered terrain scene.

A separate weapon-layer load instantiates 32 complete loadouts with independent
deterministic seeds. At 600 and 900 RPM it depletes magazines, dry-fires once
per press, reloads, resumes automatic fire, drains every event queue, and
compares event counts, rolling direction checksums, and final recoil/bloom at
30, 60, and 144 Hz. Both loads report elapsed CPU time but deliberately avoid a
machine-independent millisecond threshold.

They do **not** prove that a complete 32-player browser match meets frame budget.
That later acceptance test must include character skinning/animation, remote
tracers, network serialization, AI if present, audio contention, the actual map,
and GPU rendering on named target hardware. Remote players should generally
consume replicated shot/impact presentation rather than every client simulating
all remote rounds as gameplay authority.

## 6. Surfaces and world objects

Gameplay surfaces are explicit data: cloth, wood, sheet metal, armored metal,
stone, dirt, flesh, water, and glass. Three.js material names never determine
penetration or effects.

`WorldObjectPrefab` is deliberately smaller than an ECS. A definition composes:

```text
visual
simplified collider { kind, surface, thickness }
optional destructible { health, husk }
```

Health is optional. Cover can emit material impacts without pretending to be a
living target. The current destruction model is one resettable intact-to-husk
transition; staged damage, sectional destruction, decals, ricochet, spall, and
layered armor remain future extensions.

## 7. Controls and diagnostic URLs

Open `?scene=scope`, then press the canvas once to capture the pointer. The
capture click does not fire. Escape releases the pointer.

| Input | Scope behavior |
| --- | --- |
| mouse | look without holding a button |
| left mouse down / up | serialized trigger edges |
| right click | toggle ADS |
| Shift | sprint; while ADS, also stabilize breath and blend to precision sensitivity |
| R | leave ADS and reload |
| T | reset targets and husks |
| 1 / 2 / 3 / 4 | equip sniper / M4 / Glock / SAW (900 RPM automatic default) |
| B | cycle the equipped weapon's supported fire modes |
| `,` / `.` while ADS | increase / decrease magnification |
| Arrow Up / Down | increase / decrease elevation zero |
| Arrow Left / Right | 0.1 mrad windage clicks |
| Page Up / Page Down | full-keyboard elevation aliases |
| 0 | reset zero and windage |
| L | clear the latest debug trace |
| 1–8 in `scene=weapon&weaponanim=1` | directly inspect authored GLB animation segments |

Turret keys are consumed only while ADS, pointer-locked, and in the scope scene,
so compact Mac keyboards do not need Page Up/Down. Magnification is on comma/period
rather than `Z`/`X`: those are stance keys, and with a real motor mounted
(`&motor=1`) aiming and pressing `Z` both zoomed and went prone. Brackets were
tried first and rejected — `event.code` is physical position, so `BracketLeft`
is the `Å` key on a Nordic layout. Reload is authored animation
segment 4 (10.833333–15.0 s); gameplay reload lasts 4.2 s so a newly accepted
shot cannot cut the clip short.

Useful URLs:

| Query | Purpose |
| --- | --- |
| `?scene=scope` | playable sniper/M4/Glock/SAW proxy loadout and target slice |
| `&shotdebug=1` | white sightline, yellow bore, wide cyan curved path, material contacts |
| `&impacttest=1` | cloth/wood/metal/glass/stone/dirt/water cover lanes |
| `&ammo=9mm\|556\|308\|50bmg` | select diagnostic ballistic profile (`308` default) |
| `&windx=<m/s>&windz=<m/s>` | controlled horizontal wind |
| `&mousesens=<rad/count>` | base pointer sensitivity |
| `&scopesens=<scale>` | held-breath precision multiplier |
| `&aimcurve=<boost>` | large-delta scan boost; `0` disables it |
| `&crosshair=0` | disable the hipfire handling indicator |
| `&weaponanim=1` | enable source animation inspection in `scene=weapon` |

The rangefinder is intentionally a straight optical ray. The debug trajectory
is the evidence of gravity and wind curvature.

## 8. Module map

| Path | Responsibility |
| --- | --- |
| `core/LocalPlayerController.ts` | command buffer and authoritative player pose |
| `core/AuthoritativeAimState.ts` | undamped world-space gameplay aim |
| `core/AimSwayController.ts` | deterministic stance/breath gameplay sway |
| `core/WeaponAimComposer.ts` | allocation-free local recoil/dispersion direction composition |
| `core/FiringTimeline.ts` | one-frame trigger-to-projectile timeline and shared simulation clamp |
| `core/LookSensitivityController.ts` | FOV-scaled pointer response |
| `core/ScopeAdjustmentController.ts` | reachable zeros, elevation, and windage |
| `core/WorldQuery.ts` | the BROWSER implementations of the shared query contract: analytic terrain, collider index, composite query |
| `weapons/*` | weapon state machine, handling math, loadout slots (definitions and ammunition moved to `src/combat/`) |
| `../combat/*` (i.e. `src/combat/`) | THE SHARED BALLISTIC CORE — definitions, ammunition, projectile system, terminal model, near-field closed form. Three-free; the server runs it. Map in docs/11 §19 |
| `world/WorldObjectPrefab.ts` | simplified collider + optional destructible composition |
| `presentation/ImpactEffects.tsx` | bounded particles and positional sound |
| `presentation/ShotTrajectoryDebugView.tsx` | latest-shot world debug |
| `presentation/CharacterAimRig.ts` | procedural post-mixer bones |
| `presentation/characterClips.ts` | pure 8-way/stance/gait clip selection (Node-tested) |
| `presentation/CharacterAnimator.ts` | mixer driver: crossfades, speed matching, hips pin |
| `presentation/CharacterView.ts` | animated soldier host: model + animator + mounted aim rig |
| `presentation/soldierAssets.ts` | cached Draco GLB load + per-instance skeleton clones |
| `ui/CombatTelemetry.ts` | throttled immutable HUD snapshots |
| `ui/WeaponAimIndicator.ts` / `HipfireCrosshair.tsx` | mutable mean/cone feedback without frame-rate React state |
| `WeaponPrototype.tsx` | transitional first-person GLB/scope/frame host |
| `BallisticTestRange.tsx` | opt-in material/penetration diagnostic range |
| `TestTargets.tsx` | long-range resettable human target ladder |

`HitscanResolver.ts` remains as a tested generic/legacy resolver, but the mounted
sniper uses `BallisticProjectileSystem`. Do not accidentally route rifle fire
back through hitscan. It is also NOT the server's near-field hitscan — that is
`src/combat/HitscanBallistics.ts`, which is the same drag model solved in closed
form and bounded by the drop-budget horizon (docs/11 §12.4), not a flat ray with
flat damage.

## 9. Verification and human acceptance

After installing dependencies with `npm install` (or `npm ci` in a clean
checkout), run:

```sh
npm test
npm run typecheck
npm run build
```

Then test `?scene=scope&shotdebug=1` at 600, 1,000, and 1,300 m:

1. first click captures the pointer without firing;
2. 1/2/3/4 switch the proxy between sniper/M4/Glock/SAW gameplay definitions,
   the SAW starts in automatic, and B cycles only supported modes;
3. normal ADS can scan while Shift gives finer movement and visibly less sway;
4. stationary crouch and prone contract the hipfire crosshair while movement
   expands it; sustained fire blooms it and a pause recovers it;
5. the crosshair centre follows authoritative recoil and fades during ADS;
6. the scope readout is two small dark text rows at lower right inside the lens;
7. zeroing changes the yellow bore but not the optical rangefinder line;
8. the cyan trajectory curves and wind changes its signed drift;
9. impact damage occurs after time of flight, not on click;
10. R plays segment 4 to completion before another shot is accepted;
11. `impacttest=1` produces different material effects and plausible authored
    penetration differences;
12. the HUD's projectile/query counters remain bounded during repeated fire.

## 9.1 Two build traps, both paid for once

**`--experimental-specifier-resolution=node` in the `test` script is LOAD-BEARING.** It reads
as deprecated cruft and it is not. `node --test` runs these `.ts` files through Node's own ESM
loader, which requires fully-specified relative imports; this flag is what lets the extensionless
imports across `src/fps` resolve at all. Removing it takes the suite from 43 passing to 19
collected with 7 failing, and the failures point at the importing test rather than the cause.
It was removed on exactly that "deprecated flag" reasoning during review and put straight back.

The consequence is that **`src/fps` carries a mix of extensionless and `.ts`-suffixed relative
imports, and normalising them toward extensionless makes the problem worse.** The future-proof
migration is the other direction — add `.ts` everywhere and drop the flag, which `tsconfig`
already permits via `allowImportingTsExtensions` — but it touches every module and has not been
done. Do not tidy this halfway. `src/combat/` was born fully `.ts`-suffixed because the game
server loads it outside the test runner, where the flag does not apply.

**`engines` now declares Node >= 22.6**, which is what `--experimental-strip-types` needs. Below
that the test script fails in a way that does not name the version as the cause.

## 10. Deliberately deferred work

- timestamped sub-frame pose samples from the input layer, which is what would
  remove the combined-axis interpolation residual in §3;
- a test harness for the R3F frame host itself: `FiringTimeline` is covered
  directly, but `WeaponPrototype.tsx`'s frame ordering is only checked by
  reading it;
- authored per-weapon GLBs, animations, sounds, and final tuning;
- in-game ammunition/loadout selection and saved/rebindable controls;
- reading ecctrl for technique. The spike is CLOSED at outcome 3, custom controllers —
  see `plans/2026-08-03-ecctrl-spike-outcome.md` — but nothing was harvested because it
  was never read. Its floating-body suspension in particular avoids two failure modes we
  hit; that record says where to look if the motor misbehaves;
- vehicles of any kind. The spike's other half was not attempted;
- weapon integration BEYOND the handling context. `?scene=scope&motor=1` now carries the
  weapon on a collided body, and stance, planar speed and real grounded state reach
  `WeaponHandlingContext` from the motor rather than being inferred from the camera. Rounds
  leave the motor's eye rather than the camera, aim intent and reloading slow the player,
  and **sprinting refuses the shot outright** — a content constraint, since the authored
  animation set has no sprint-and-fire pose. What is still missing: recoil does not push
  the body;
- character animation landed 2026-08-03: the V third-person view and networked remotes
  render the animated soldier through `CharacterView` (locomotion, stances, jump,
  speed-matched playback, mounted aim rig). Still open from that pass: prone clips do not
  exist in the pack (prone borrows the crouch set until the runbook §4 bake adds them),
  an aim/ADS flag is not on the snapshot wire (idle aiming variants unused for remotes),
  deaths and turn-in-place are unwired, the lit GLB bypasses `atmosphere.shade` (docs/08
  §8 invariant 7's known gap), and the bot harness plus the 32/64-rig browser benchmark
  remain missing;
- replication of anything beyond player motor state, and remote tracers. Authority,
  prediction and reconciliation now exist for MOVEMENT only; see doc 12;
- full piecewise drag/weather model, moving target lead aids, and wind estimation;
- attachment inventory/slots, stamina, injury, suppression, bipods, leaning,
  supported-fire detection, and authored recoil-pattern textures;
- ricochet, decals, spall, layered armor, staged destruction, and death bodies;
- production weapon firing/reload audio and authored material effect assets;
- a full-match CPU/GPU/network performance benchmark on target hardware.

Keep those additions behind the existing boundaries. In particular, do not use
Rapier rigid bodies for rifle bullets, do not derive gameplay surface behavior
from render materials, do not read bones to resolve a shot, and do not restore
recursive raycasts over visual terrain.
