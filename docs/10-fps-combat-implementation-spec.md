# FPS Combat Implementation Spec — as built

**Audience:** anyone resuming FPS, weapons, combat, character-aim, or related
multiplayer work without the history of the prototype sessions.

This is the canonical as-built description of `src/fps/**`. The dated files in
`docs/plans/` explain individual decisions; `src/fps/README.md` is the compact
operator reference. If a dated proposal disagrees with this document, this
document describes the current implementation. Terrain and grass remain covered
by `08-implementation-spec.md` and the terrain-specific design documents.

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
is one proxy FPS rig shared by the selectable sniper, M4, and Glock, no physical
character controller, no network authority, no remote-character presentation,
and no in-game loadout or settings screen. The SAW is a complete
semi/automatic gameplay and load-test definition but is not in the development
loadout. Authored per-weapon models and animations have not been added.

## 2. Ownership and data flow

High-frequency gameplay truth lives in mutable TypeScript systems. React/R3F
mounts those systems, adapts them to Three.js presentation, and publishes
throttled snapshots to the HUD.

| Layer | Owns | Must not own |
| --- | --- | --- |
| `LocalPlayerController` | input commands, position, stance, planar speed, authoritative world aim | meshes, bones, scope materials |
| `AimSwayController` | deterministic gameplay sway and breath stabilization | a second cosmetic-only shot direction |
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
  -> weapon/loadout update queues an accepted shot event
  -> authoritative base aim + gameplay sway
  -> event-captured pre-shot recoil offset
  -> scope turret-adjusted mean bore
  -> event-captured deterministic dispersion
  -> drain accepted shot event with its resolved directions
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
advance existing projectiles
drain impact/result events
sample player pose, planar speed, stance, grounded state, and breath
set equipped-weapon handling context
consume current input commands
update weapon/loadout cadence, reload, ADS, recoil, and bloom recovery
update ADS presentation blend
update authoritative sway from stance + ADS + breath
derive base and current mean sight directions
derive current turret-adjusted mean bore
sync AuthoritativeAimState
drain accepted weapon events, compose each captured offset, and spawn projectiles
update mixer, cosmetic recoil, crosshair, and presentation
render scope/world/weapon passes
```

A projectile spawned this frame never receives time that elapsed before the
trigger press. A shot always captures one normalized origin/sight/bore state;
later camera, sway, or turret motion does not bend a projectile already in
flight.

For third-person characters, preserve the separate mandatory lifecycle:

```ts
aimRig.beginFrame();
mixer.update(dt);
aimRig.update(dt);
```

`CharacterAimRig` is implemented and unit tested but is not mounted on a live
third-person character or bot harness yet. See
`character-aim-rig-spec-v2.md`.

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
| 1 / 2 / 3 | equip sniper / M4 / Glock |
| B | cycle the equipped weapon's supported fire modes |
| Z / X while ADS | increase / decrease magnification |
| Arrow Up / Down | increase / decrease elevation zero |
| Arrow Left / Right | 0.1 mrad windage clicks |
| Page Up / Page Down | full-keyboard elevation aliases |
| 0 | reset zero and windage |
| L | clear the latest debug trace |
| 1–8 in `scene=weapon&weaponanim=1` | directly inspect authored GLB animation segments |

Turret keys are consumed only while ADS, pointer-locked, and in the scope scene,
so compact Mac keyboards do not need Page Up/Down. Reload is authored animation
segment 4 (10.833333–15.0 s); gameplay reload lasts 4.2 s so a newly accepted
shot cannot cut the clip short.

Useful URLs:

| Query | Purpose |
| --- | --- |
| `?scene=scope` | playable sniper/M4/Glock proxy loadout and target slice |
| `&shotdebug=1` | white sightline, yellow bore, cyan curved path, material contacts |
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
| `core/LookSensitivityController.ts` | FOV-scaled pointer response |
| `core/ScopeAdjustmentController.ts` | reachable zeros, elevation, and windage |
| `core/WorldQuery.ts` | analytic terrain, collider index, composite query |
| `weapons/*` | definitions, ammunition, handling math, weapon state, generic loadout slots |
| `combat/BallisticProjectileSystem.ts` | pooled active rounds and authoritative contacts |
| `combat/BallisticModel.ts` | allocation-free gravity/drag/wind velocity step |
| `combat/SurfaceProfile.ts` / `PenetrationResolver.ts` | material tuning and terminal response |
| `combat/Damageable.ts` | health/hit/reset contract |
| `world/WorldObjectPrefab.ts` | simplified collider + optional destructible composition |
| `presentation/ImpactEffects.tsx` | bounded particles and positional sound |
| `presentation/ShotTrajectoryDebugView.tsx` | latest-shot world debug |
| `presentation/CharacterAimRig.ts` | procedural post-mixer bones |
| `ui/CombatTelemetry.ts` | throttled immutable HUD snapshots |
| `ui/WeaponAimIndicator.ts` / `HipfireCrosshair.tsx` | mutable mean/cone feedback without frame-rate React state |
| `WeaponPrototype.tsx` | transitional first-person GLB/scope/frame host |
| `BallisticTestRange.tsx` | opt-in material/penetration diagnostic range |
| `TestTargets.tsx` | long-range resettable human target ladder |

`HitscanResolver.ts` remains as a tested generic/legacy resolver, but the mounted
sniper uses `BallisticProjectileSystem`. Do not accidentally route rifle fire
back through hitscan.

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
2. 1/2/3 switch the proxy between sniper/M4/Glock gameplay definitions and B
   cycles only supported modes;
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
done. Do not tidy this halfway.

**`engines` now declares Node >= 22.6**, which is what `--experimental-strip-types` needs. Below
that the test script fails in a way that does not name the version as the cause.

## 10. Deliberately deferred work

- authored per-weapon GLBs, animations, sounds, and final tuning;
- in-game ammunition/loadout selection and saved/rebindable controls;
- Rapier-backed player collision, slopes, stance clearance, and vehicles;
- third-person character host, bot harness, and 32/64-rig browser benchmark;
- network authority, prediction/reconciliation, replication, and remote tracers;
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
