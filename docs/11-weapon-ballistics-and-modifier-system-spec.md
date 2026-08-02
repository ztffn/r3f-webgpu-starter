# Weapon, Ballistics, and Modifier System Spec

**Status:** canonical as-built specification with forward extension contracts

**Last verified:** 2026-08-02

**Implementation:** `src/fps/weapons/**`, `src/fps/combat/**`, and the adapter in
`src/fps/WeaponPrototype.tsx`

## 1. Purpose and precedence

This document explains the complete lifecycle from a trigger command to a
resolved projectile, surface interaction, damage report, and presentation
event. It is the detailed source of truth for weapon acceptance, spread,
recoil, external ballistics, penetration, and their future modifier seams.

Sections marked **as built** describe code that exists and is covered by tests.
Sections marked **extension contract** constrain future attachments, perks,
alternate ammunition, status effects, and networking without claiming those
features exist today.

Use the documentation in this order when changing combat code:

1. this document for weapon, projectile, and modifier invariants;
2. `10-fps-combat-implementation-spec.md` for the wider FPS frame and ownership
   model;
3. dated files in `docs/plans/` for decision history and rejected alternatives;
4. `src/fps/README.md` for controls and human-test instructions.

If a dated plan disagrees with this document, this document describes the
current implementation. The live code and passing tests remain final evidence.

## 2. Goals and non-goals

The system is designed to provide:

- data-driven weapons and ammunition without presentation assets in gameplay
  definitions;
- deterministic command-driven semi, burst, and automatic fire;
- stance-, movement-, ADS-, breath-, recoil-, and bloom-dependent accuracy;
- delayed projectile travel with gravity, drag, wind, and swept collision;
- authored surface resistance, bounded penetration, and delayed damage;
- explicit event seams for HUD, animation, particles, audio, and future
  replication;
- bounded projectile storage and measurable failure behavior;
- equivalent gameplay outcomes across ordinary render-frame cadences.

The current implementation is not:

- a laboratory-grade G1 drag solver;
- a rigid-body bullet simulation;
- a generic modifier or inventory framework;
- a final balance model for weapon damage or penetration;
- a ricochet, spall, armor-layer, limb, or suppression simulation;
- a networking transport or server process;
- proof that a fully rendered 32-player match meets frame budget.

The guiding separation is simple: a weapon accepts a shot and freezes its local
state; the projectile system advances that accepted shot through the world;
presentation observes events from both systems but never decides either result.

## 3. Terminology and units

| Term | Meaning |
| --- | --- |
| command | Plain input intent such as `triggerDown`, `reload`, or `equipSlot` |
| accepted shot | A round that passed cadence, reload, and ammunition checks and consumed one cartridge |
| sight direction | Authoritative optical aim after sway and pre-shot recoil, before scope turret adjustment |
| bore direction | Sight direction after elevation zero and windage adjustment |
| projectile direction | Bore direction after the accepted deterministic dispersion sample |
| recoil impulse | Pitch/yaw added after accepting a shot; it can affect later shots, never the shot that caused it |
| dispersion cone | Angular radius within which the next projectile direction may be sampled |
| bloom | Bounded, recoverable dispersion added by accepted shots |
| interaction | One projectile contact with an authored surface |
| result | Completed projectile outcome after stopping, range exhaustion, or lifetime expiration |

All world distances and collider thicknesses are metres. Time is seconds,
velocity is metres per second, mass is kilograms, energy is joules, and angular
values are radians. Documentation may show milliradians for readability:
`1 mrad = 0.001 rad`.

Directions passed to projectile spawn are world-space vectors. Weapon recoil
and dispersion offsets are local yaw/pitch angles composed by
`WeaponAimComposer`.

## 4. Ownership boundaries

| Owner | Owns | Must not own |
| --- | --- | --- |
| `LocalPlayerController` | ordered local commands and authoritative world-space aim | cadence, GLTF state, projectile truth |
| `LoadoutSystem` | numeric slot mapping, equipped weapon, switch timing, promotion of weapon events | asset selection, ballistics |
| `WeaponSystem` | ammunition counts, cadence, fire mode, reload, ADS, trigger/burst state, recoil, bloom, sequence and accepted-shot events | camera, physics bodies, raycasts, animation |
| future modifier resolver | deterministic combination of weapon, ammunition, attachment, perk, and status sources | per-frame presentation or hidden randomness |
| `ScopeAdjustmentController` | ammunition-calibrated elevation presets and windage clicks | collision or damage |
| `BallisticProjectileSystem` | projectile pool, fixed-step motion, swept queries, penetration continuation, damage timing, impact/result events | weapon input, React, audio, particles |
| `WorldQuery` | nearest gameplay collision against CPU terrain and registered simplified colliders | visual terrain/grass scene traversal |
| `Damageable` | health mutation for an accepted damage request | projectile motion or presentation |
| React/R3F presentation | model, mixer, scope, crosshair, HUD, trace, impact particles and audio | gameplay acceptance or authority |

Gameplay definitions contain no `import.meta.url`, loader, animation clip,
Three.js object, DOM object, or callback. Presentation may select a GLTF and
animation segments by weapon ID, but replacing that mapping cannot change
weapon behavior.

## 5. End-to-end shot lifecycle

### 5.1 High-level flow

```text
ordered WeaponCommand
  -> LoadoutSystem routes to equipped WeaponSystem
  -> WeaponSystem advances to exact cadence boundary
  -> accepted WeaponEvent freezes shot-local state
  -> adapter composes sight, bore, and dispersion
  -> BallisticProjectileSystem.spawn freezes projectile state
  -> 120 Hz integration + swept WorldQuery
  -> zero or more ImpactEvents
  -> optional Damageable mutations and TargetHitReports
  -> one completed BallisticResult + ShotTrace
  -> HUD, debug trace, particles, audio, and future replication
```

### 5.2 Current frame order

The mounted FPS prototype uses this order:

```text
clamp the render delta once into one simulation delta
sample player pose, stance, grounded state, planar speed, and breath
set equipped-weapon handling context
consume ordered commands
advance every loadout weapon, switching, cadence, reload, ADS, and recovery
run the FiringTimeline over this frame's accepted events, in cadence order
drain impact and completed-result events
update mixer and cosmetic recoil
render scope, world, and weapon passes
```

`FiringTimeline` is the single simulation timeline for the frame. For each
accepted event in order it advances gameplay sway and the projectile solver to
that event's acceptance offset, interpolates the player pose there, composes
sight, mean bore, and projectile directions, spawns, and then continues. After
the last event it advances both to the end of the frame.

The weapon runtime, gameplay sway, and the projectile solver therefore share one
clamped delta (`MAX_SIMULATION_FRAME_SECONDS`, 0.1 s). A projectile receives
exactly the time after its own acceptance boundary, never time that elapsed
before the trigger command; a round accepted exactly on the frame edge begins
its flight in the following frame. Handling context is supplied before
commands because a trigger-down edge may accept a semi-auto or first automatic
round immediately.

### 5.3 Freeze points

There are three important freeze points:

1. `WeaponEvent.type === "shot"` captures sequence, the acceptance offset inside
   the update that accepted it, damage, range, lifetime, ammunition, pre-shot
   recoil, sampled dispersion, cone radius, and the new recoil impulse. Rounds
   accepted by a command between updates report offset `0`.
2. `FiringTimeline` freezes the interpolated origin and base orientation at that
   offset, together with the sway state advanced to the same instant.
3. `BallisticProjectileSystem.spawn()` clones/normalizes origin, projectile
   direction, sight direction, and mean bore direction and stores the remaining
   launch data.

Later camera motion, recovery, mode changes, attachment changes, or player perks
must not bend or retune an already accepted projectile.

## 6. Weapon definitions and runtime acceptance — as built

`WeaponDefinition` contains five gameplay groups:

- `shot`: ballistic mode, nominal damage, maximum path length, maximum flight
  time, rounds per minute, and ammunition;
- `ammo`: magazine capacity and initial reserve;
- `reload`: gameplay lock duration;
- `fireModes`: ordered supported modes, default mode, and optional burst size;
- `ads`, `accuracy`, and `recoil`: transition and handling values.

The constructor validates every authored runtime number before any state is
built: unsupported defaults, duplicate modes, invalid burst sizes, non-finite or
non-positive cadence, shot range, shot lifetime and reload duration, negative or
non-finite damage and ADS timings, fractional or negative magazine and reserve
counts, the referenced ammunition's mass, muzzle velocity, ballistic
coefficient, penetration multiplier and base damage, negative/non-finite
handling values, and recoil or bloom caps smaller than one authored impulse.
Projectile spawn separately validates its launch and ammunition inputs.

The constructor also requires an explicit integer `instanceSeed`. There is no
definition-derived default: it silently gave every copy of a weapon one shared
recoil and dispersion pattern. Use `deriveWeaponInstanceSeed(shooterSeed, slotId,
weaponId)` — `createDevelopmentLoadout(shooterSeed)` does exactly that, so
replaying a shooter seed reproduces every pattern while separate shooters
carrying the same weapon diverge.

### 6.1 Serializable commands

```ts
type WeaponCommand =
  | { type: "triggerDown" }
  | { type: "triggerUp" }
  | { type: "selectFireMode" }
  | { type: "reload" }
  | { type: "equipSlot"; slot: number };
```

Commands describe meaning, not hardware events. A later network envelope may
add player identity, sequence, and simulation tick without changing them.

### 6.2 Fire-mode rules

- **Semi:** one accepted attempt on each trigger-down edge. Holding never
  repeats.
- **Burst:** a trigger-down edge starts one authored burst. Once accepted, its
  remaining rounds advance from cadence even after trigger release.
- **Automatic:** attempts immediately on trigger down, then at every cadence
  boundary while held.
- A single update may cross multiple cadence boundaries. There is no
  one-shot-per-render-frame restriction.
- Reload, switching, and mode changes cancel an incomplete burst.
- Mode changes preserve cooldown, recoil, and bloom.
- An empty automatic weapon emits one dry-fire event per trigger press.
- Weapon updates accept at most 100 ms per call, preventing a background-tab
  hitch from producing a large catch-up burst.

### 6.3 Reload and switching

Reload transfers `min(magazine capacity - magazine, reserve)` only when its
timer completes. The current proxy-visible reload lock is 4.2 seconds.

Switching drains previously accepted source events before deactivating the old
weapon. Deactivation clears trigger, automatic, burst, reload, ADS, and queued
events. It does not restore ammunition and does not reset recoil or bloom.
Every loadout weapon continues receiving update time, so handling recovery does
not freeze while unequipped.

## 7. Accuracy, recoil, and deterministic dispersion — as built

### 7.1 Cone construction

```text
movementFactor = clamp(planarSpeed / 5.5 m/s, 0, 2)
adsFactor = lerp(1.0, 0.12, adsProgress)
breathFactor = lerp(1.0, 0.75, breathStabilization * adsProgress)
stanceFactor = stand 1.00 | crouch 0.62 | prone 0.30

groundedHandling =
  (hip * adsFactor + movement * movementFactor)
  * stanceFactor
  * breathFactor

standingMovementBaseline =
  (hip * adsFactor + movement) * breathFactor

handling = grounded
  ? groundedHandling
  : max(groundedHandling + airborne, standingMovementBaseline)

coneRadius =
  (mechanicalDispersion + handling) * dispersionFactor + currentBloom
```

Mechanical dispersion remains even when prone and fully aimed. Breath affects
handling only while ADS. Bloom is added after `dispersionFactor`, so the current
modifier does not scale existing bloom.

### 7.2 Deterministic sample

Every weapon instance has a 32-bit seed and monotonically increasing shot
sequence. Hashing those values produces radius and angle samples. The radius
uses `sqrt(u)` so samples are uniform over the cone's disk rather than biased
toward its centre.

The hot path does not use `Math.random`, wall time, render-frame count, or a
retained recoil-pattern array. Identical definition, instance seed, command
timeline, and handling inputs produce identical shot offsets in current tests.
Different instance seeds keep 32 shooters from sharing one pattern.

This is gameplay reproducibility inside the supported JavaScript runtime, not
a promise of bit-identical floating-point results across every future engine or
hardware implementation.

### 7.3 Recoil and bloom order

At each accepted cadence boundary:

1. recover prior recoil and bloom up to the boundary;
2. calculate the cone and sample dispersion;
3. emit the shot with recoil that existed before this shot;
4. apply this shot's recoil impulse and bloom;
5. continue through any remaining accepted interval.

Recoil and bloom recover exponentially in simulation time. Pitch is positive
and capped; yaw chooses a deterministic sign and is capped symmetrically.
This ordering guarantees that a shot cannot change its own accepted direction,
while later rounds inherit earlier impulses.

## 8. Modifier boundary — as built

`WeaponSystem.setHandlingModifiers()` currently accepts one complete flattened
`WeaponHandlingModifiers` value:

| Channel | Current effect |
| --- | --- |
| `dispersionFactor` | scales mechanical plus handling dispersion, not existing bloom |
| `recoilPitchFactor` | scales pitch impulse and pitch cap |
| `recoilYawFactor` | scales yaw impulse and yaw cap |
| `recoilRecoveryFactor` | scales exponential recoil recovery rate |
| `bloomPerShotFactor` | scales bloom added by future accepted shots |
| `bloomRecoveryFactor` | scales exponential bloom recovery rate |
| `swayFactor` | exported in the snapshot and consumed by `AimSwayController` |

All default factors are `1`. Values are clamped to finite non-negative numbers,
but they have no authored upper bound. The setter replaces the prior flattened
set; it does not accumulate sources.

There are currently no attachment slots, perk definitions, temporary effects,
modifier source IDs, stacking rules, provenance records, or replicated modifier
revision. No current modifier changes damage, muzzle velocity, ballistic
coefficient, projectile mass, penetration multiplier, cadence, magazine size,
reload duration, range, or flight lifetime.

These limitations are intentional. The weapon runtime consumes resolved
numbers; it should not become an inventory or character-progression system.

## 9. Attachment and perk resolution — extension contract

Attachments and perks must be resolved outside `WeaponSystem` into immutable,
plain-data runtime inputs. Do not let the weapon iterate an inventory, inspect
React state, or ask a character object for perks on every shot.

The implementation phases, proposed TypeScript contracts, migration rules, and
exit gates are specified in
`plans/2026-08-02-weapon-ballistics-modifier-roadmap.md`.

### 9.1 Required source order

Use one canonical deterministic order:

```text
base weapon definition
  -> selected ammunition/load data
  -> attachments in authored slot order
  -> player perks in stable perk-ID order
  -> temporary gameplay statuses in stable source-ID order
  -> validation and final clamps
  -> resolved weapon configuration + provenance/revision
```

The exact future TypeScript type is deliberately not frozen yet, but the
resolver must satisfy these rules:

- sources and output are serializable data;
- every source has stable identity and an explicit category;
- multiplicative channels start at `1` and multiply;
- additive channels start at `0` and add;
- overrides use a named policy, never incidental array order;
- final validation/clamping happens once after combination;
- resolving the same ordered inputs produces the same output and revision;
- shared base definitions are never mutated;
- the authority can recreate the result without GLTFs or React;
- snapshots/replays identify the resolved revision used by accepted shots.

### 9.2 Keep physical and handling channels distinct

Future modifier channels should be separated by meaning:

1. **Handling:** dispersion, recoil, bloom, sway, ADS, reload, and ergonomics.
2. **Launch:** muzzle velocity, nominal damage, cadence, range, and lifetime.
3. **Ammunition:** mass, ballistic coefficient, penetration multiplier, and
   ammunition identity.
4. **Capacity/action:** magazine capacity, chamber behavior, reload stages, and
   fire modes.

For example, a stock may affect recoil and sway, a barrel may affect handling
and muzzle velocity, a magazine may affect capacity and reload, and ammunition
selection may replace mass/BC/penetration data. A perk may modify handling or
action timing, but it should not silently rewrite physical ammunition data
unless game design names that behavior explicitly.

Avoid a universal `Record<string, number>` modifier bag. Named typed channels
make invalid combinations visible and let tests state which stage owns each
clamp.

### 9.3 Runtime update rules

Resolve modifiers when a loadout is created or when an actual source changes,
not every render frame. Applying a new result affects later weapon boundaries
and later projectiles only. An in-flight projectile retains the launch and
ammunition values captured at spawn.

When source changes are eventually allowed during reload, burst, or equipment
switching, define one explicit policy per change type. Do not accidentally use
re-resolution to reset cooldown, recoil, bloom, burst progress, or ammunition.

### 9.4 Required future tests

Before attachments or perks ship, add tests for:

- source-order independence where the operation is commutative;
- stable explicit ordering where it is not;
- identity modifiers producing the unchanged base configuration;
- conflicting overrides following the documented policy;
- invalid/hostile values failing or clamping at the resolver boundary;
- no mutation of base definitions or other weapon instances;
- snapshot/replay reproduction from resolved revision and seed;
- modifier changes affecting only shots accepted after the change;
- 32-player load with representative attachment/perk combinations.

## 10. Projectile simulation — as built

### 10.1 Spawn contract

`BallisticProjectileSystem.spawn()` accepts source and sequence identity,
origin, projectile direction, optional sight direction, optional
turret-adjusted mean bore direction, maximum distance, maximum lifetime,
nominal damage, ammunition, and optional trace capture. Sight and bore both
default to the projectile direction. All three are retained on `ShotTrace` so
diagnostics can separate scope elevation and windage from this shot's
dispersion sample; drawing the projectile direction as the bore reports random
spread as a turret adjustment.

Spawn rejects and counts:

- an exhausted pool;
- zero, non-finite, or invalid direction/origin;
- non-positive range or lifetime;
- negative/non-finite damage;
- non-positive/non-finite muzzle velocity, ballistic coefficient, mass, or
  penetration multiplier.

Rejected spawns never replace live projectiles. The caller currently reports a
rejection through combat telemetry.

### 10.2 Fixed-step integration

The default environment is:

- fixed step: `1 / 120` seconds;
- maximum accumulated catch-up: `0.25` seconds;
- gravity: `(0, -9.80665, 0)` m/s²;
- development wind: `(4, 0, 0)` m/s.

Each fixed step:

1. computes air-relative velocity (`projectile velocity - wind`);
2. applies gravity and quadratic drag acceleration;
3. updates displacement with the average of old and new velocity;
4. clamps the segment to remaining distance and lifetime;
5. sweeps one `WorldQuery.raycast` over the complete segment;
6. advances to the hit or the segment end.

The drag coefficient is:

```text
dragPerMetre = 0.000404 / ballisticCoefficientG1
dragAcceleration = dragPerMetre * airRelativeSpeed²
```

This is a calibrated single-coefficient G1 approximation. It is not a
piecewise standard G1 drag table and should not be presented as one. Both live
projectiles and scope-zero prediction call the same allocation-free velocity
integrator, preventing two independent drag models from drifting apart.

### 10.3 Pool layout and lifetime

The default pool has 2,048 slots. Position, velocity, origin, direction,
distance, elapsed time, damage totals, and counters use structure-of-arrays
typed storage. Free and active slot arrays avoid creating a projectile object
inside the hot fixed-step loop.

A projectile completes when it stops, reaches maximum path length, or reaches
maximum flight time. Completion creates result objects at the event boundary
and immediately recycles the slot.

## 11. World collision — as built

`CompositeWorldQuery` returns the nearer result from:

- `HeightfieldWorldQuery`, which traverses the canonical CPU heightfield; and
- `ThreeWorldQuery`, which checks only explicitly registered simplified
  gameplay colliders.

Rendered terrain, grass shells, canopy proxies, LOD meshes, weapon models, and
unrelated scene roots are never ballistic collision authority. Registering
visual terrain is forbidden. Projectile cost remains tied to heightfield cells
and nearby gameplay colliders, not scene complexity.

Registered colliders provide kind, stable object ID, surface ID, penetration
thickness, and optional `Damageable`. The X/Z index uses 32 m cells. Large or
invalid bounds fall back to an unindexed set rather than disappearing. Moving
colliders must call their registration handle's `refresh()` after changing
world bounds.

One ray spans every fixed-step displacement, so thin objects between discrete
positions are not skipped. This is swept point-projectile collision, not a
Rapier rigid body and not a volumetric bullet shape.

## 12. Penetration and damage — as built

### 12.1 Energy model

Kinetic energy is:

```text
energy = 0.5 * projectileMassKilograms * speedMetresPerSecond²
```

Incidence increases the authored path through material, capped per surface:

```text
pathMultiplier = min(surface.maxIncidencePathMultiplier, 1 / incidenceCosine)
effectiveThickness = colliderThickness * pathMultiplier
energyCost =
  surface.resistanceJoulesPerMetre
  * effectiveThickness
  / ammunition.penetrationMultiplier
retainedEnergy = max(0, energyBefore - energyCost)
```

The implementation safely handles grazing incidence by capping the reciprocal
before it can become infinite. The round penetrates only when retained energy
reaches the surface's minimum exit energy. Invalid negative/non-finite thickness
fails closed in the pure penetration resolver.

### 12.2 Continuation

A penetrating round:

- emits an `ImpactEvent` with entry and computed exit points;
- advances through authored effective thickness plus 2 mm;
- converts retained energy back to speed;
- continues in the same pool slot and same direction.

The current model does not deflect or ricochet. One projectile is bounded to
eight surface interactions. Reaching the interaction limit converts the final
contact to `stopped` even if the energy calculation alone would penetrate.

### 12.3 Damage

Every contacted collider with a `Damageable` receives damage at simulated
impact time, whether the round stops or penetrates. Nominal weapon damage is
scaled by energy before that interaction:

```text
damageScale = clamp(
  energyBeforeInteraction / (muzzleEnergy * 0.7),
  0.1,
  1.0
)
appliedRequest = nominalWeaponDamage * damageScale
```

`Damageable` clamps applied damage to remaining health. Penetration therefore
reduces damage at later contacts through retained speed; ordinary flight keeps
full nominal damage until energy falls below 70% of muzzle energy. The 10%
floor and nominal values are game tuning, not physical claims.

## 13. Events, reports, traces, and presentation

### 13.1 Event timing

| Output | Emitted when | Typical consumers |
| --- | --- | --- |
| weapon `shot` | weapon accepts and consumes a round | projectile spawn, muzzle animation, cosmetic recoil |
| `ImpactEvent` | projectile touches each surface | hit marker, particles, positional audio, contact telemetry |
| `TargetHitReport` | damage is applied to a target | target/UI reporting |
| `BallisticResult` | projectile completes | completed-shot telemetry and debug trace |

An impact is intentionally observable before the completed result when a round
penetrates and continues. Consumers must not wait for `BallisticResult` to play
the first impact effect.

### 13.2 Completed result semantics

`BallisticResult` contains:

- the frozen spawned shot;
- final stopping hit or `null`;
- total applied damage and destruction flag;
- the last target report plus all target reports;
- a `ShotTrace` with sight direction, mean bore direction, initial projectile
  direction, sampled points, every surface interaction, final impact, flight
  time, drop, drift, path length, and impact speed.

A projectile that penetrates a target and later expires may have target reports
while its final `hit` is `null`. Code must not equate `result.hit === null` with
“this shot touched nothing.” Inspect `reports` and `trace.interactions`.

Because of that, consumers must keep three groups of fields apart, and
`CombatTelemetry.ShotTelemetry` now does so structurally:

| Group | Source | Example |
| --- | --- | --- |
| target | `result.report` only | damage and health of the last damaged target |
| aggregate | `result.damageApplied` / `destroyed` / `reports.length` | shot-wide totals |
| terminal | the round's last authored-surface contact, with a `stopped` flag | stopping distance, surface, exit speed |

Merging them lets a round that penetrates a target and then hits terrain credit
that target with the terrain's distance and object name, and lets one destroyed
target mark a different, surviving target as down.

### 13.3 Queue and history policy

- Weapon and loadout event arrays are operationally bounded by the caller
  draining every update; they do not have a hard capacity.
- The projectile impact-event queue has a hard capacity of 4,096. Overflow is
  dropped and counted.
- The completed-result queue is drained every frame and has no retained
  history contract.
- Trace buffers hold at most 1,024 points per traced projectile and are pooled.
- Runtime local fire passes `captureTrace` only when `shotdebug=1`; load/remote
  cases should pass `false`.
- `ShotDebugStore` retains only the latest completed trace.
- `CombatTelemetry` retains five recent shot summaries.

Presentation may pool, cull, simplify, delay, or omit remote tracers and effects.
It may not raycast independently and report a different gameplay result.

## 14. Ammunition and surface data — as built

Current ammunition values are representative starting points:

| ID | Display | Mass | Muzzle velocity | G1 BC | Base damage | Penetration multiplier |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `9mm` | 9x19 mm 124 gr | 0.00804 kg | 350.52 m/s | 0.159 | 42 | 0.72 |
| `556` | 5.56x45 mm 62 gr | 0.00402 kg | 920.5 m/s | 0.349 | 68 | 1.15 |
| `308` | .308 Winchester 175 gr | 0.01134 kg | 792.48 m/s | 0.505 | 100 | 1.08 |
| `50bmg` | .50 BMG 660 gr | 0.0428 kg | 853 m/s | 0.62 | 250 | 2.35 |

Current surfaces are cloth, wood, sheet metal, armored metal, stone, dirt,
flesh, water, and glass. Each profile separates gameplay resistance/minimum
exit energy/incidence cap from effect color, particle count/speed, sound kind,
and audible distance. Material names and rendered colors never infer gameplay
surface identity.

Alternate ammunition should be a distinct definition or selected load identity,
not an in-place mutation of a shared ammunition object. If future barrels or
perks alter launch values, the resolved shot must still retain an explicit base
ammunition identity and resolved launch values for replay and diagnostics.

## 15. Determinism, snapshots, and future networking

### 15.1 What exists

- weapon commands are serializable and ordered;
- weapon snapshots expose fire mode, ammo, phase, timers, trigger/burst state,
  sequence, seed, recoil, bloom, cone, and sway factor;
- accepted shot randomness derives from instance seed and shot sequence;
- weapon cadence and projectile integration are independent of render-frame
  cadence in covered timelines;
- projectiles copy launch vectors and carry source/sequence identity.

### 15.2 What does not yet exist

- tick/sequence envelopes around commands;
- a serializer for complete weapon/projectile state;
- modifier source/revision replication;
- rollback and replay orchestration;
- server transport, reconciliation, lag compensation, or remote ownership;
- cross-runtime bitwise determinism guarantees.

### 15.3 Authority contract

A future server-authoritative path should replicate or reconstruct:

- shooter and weapon-instance identity;
- command sequence and simulation tick;
- resolved weapon/ammunition revision;
- deterministic instance seed and shot sequence;
- accepted origin, sight/bore/projectile direction as required by the chosen
  prediction protocol;
- authoritative impact, damage, and destruction outcomes.

The local player may predict their own projectiles. Remote clients should
normally consume replicated shot/impact presentation rather than independently
treating every remote projectile simulation as authority.

## 16. Performance and failure budgets

| Budget/guard | Current value or behavior |
| --- | --- |
| projectile fixed step | 120 Hz |
| ballistic catch-up cap | 0.25 s (internal guard; the frame host clamps first) |
| shared simulation frame clamp | 0.1 s for weapons, sway, and projectiles |
| weapon update hitch cap | 0.1 s per call |
| projectile pool | 2,048 slots |
| trace storage | 1,024 points per traced projectile |
| surface interactions | 8 per projectile |
| impact-event queue | 4,096 events |
| collider grid | 32 m X/Z cells |
| impact particles | 384 pooled instances |
| impact audio | 24 bounded voices |
| debug history | latest completed trace |
| HUD shot history | five summaries |

Metrics expose active/peak projectiles, spawns, rejected spawns, completions,
fixed steps, swept queries, interactions, dropped impact events, and expirations.
The frame host also samples ballistic CPU time and world-query counters.

Performance tests report elapsed CPU time but do not assert a machine-specific
millisecond threshold. Passing them proves bounded behavior and regression
relationships, not shipping performance on target hardware.

## 17. Verification matrix

The current suite covers:

- command ordering, fire-mode semantics, reload/switch cancellation, dry fire,
  cooldown preservation, and hitch bounds;
- hostile authored definition values rejected before state is built, and an
  invalid equip duration rejected before switch state is touched;
- exact per-round acceptance offsets inside an update, including after a reload;
- end-to-end trigger-to-projectile equivalence at 30/60/144 Hz for a stationary
  shooter (exact) and a moving, turning shooter (within the pose-reconstruction
  residual), comparing origins, sight/bore/projectile directions, acceptance
  times, and resolved results;
- distinct sight, mean bore, and projectile directions on the resolved trace;
- target/aggregate/terminal telemetry separation for target-then-terrain,
  target-then-expiry, and two damaged targets where only one is destroyed;
- shot and impact presentation identity across weapons that share a sequence;
- deterministic dispersion, required instance seeds, and per-slot seed
  derivation that replays for one shooter and diverges between shooters;
- stance, movement, airborne, ADS, breath, modifier, recoil, bloom, and recovery
  relationships;
- exact 32-loadout event/ammo/reload outcomes at 600 and 900 RPM under 30, 60,
  and 144 Hz render deltas;
- increasing drop/time through 1,300 m and equal/opposite wind drift;
- swept thin-target collision and delayed damage;
- spawn validation, pool exhaustion, and lifetime expiration;
- penetration, invalid thickness, multiple cadence timelines, and a 32-player
  900 RPM cloth-impact load;
- analytic terrain queries, spatial collider filtering, and nearest composite
  collision;
- scope zeros using the shared ballistic integrator;
- bounded telemetry and latest-only debug trace retention.

Run the complete gate after changing weapon, modifier, projectile, query,
surface, or damage code:

```sh
npm test
npm run typecheck
npm run build
```

Preserve the Node test flags in `package.json`; TypeScript stripping and
specifier resolution are load-bearing for the current test runner.

## 18. Tuning and change procedure

### 18.1 Changing a weapon

1. Change gameplay values in `weaponDefinitions.ts`, never in the GLTF adapter.
2. Check definition validation and supported fire-mode order.
3. Add/update exact cadence, ammunition, recoil, bloom, and loadout assertions.
4. Run the 30/60/144 Hz equivalence and 32-system load tests.
5. Human-test crosshair, shot trace, ammo/reload telemetry, and proxy animation.

### 18.2 Changing ammunition or drag

1. Record whether values are sourced physical inputs or deliberate game tuning.
2. Update live projectile and scope-zero expectations together.
3. Re-run drop/time/wind ladders, lifetime bounds, penetration cases, and long
   range human tests.
4. Do not tune nominal damage to conceal an error in velocity/energy units.

### 18.3 Changing penetration or surfaces

1. Keep gameplay surface values separate from visual effects.
2. Test square and oblique incidence, invalid thickness, stop/exit thresholds,
   downstream damage, and the interaction cap.
3. Verify moving collider registration/refresh where relevant.
4. Re-run the 32-player contact load and inspect dropped-event metrics.

### 18.4 Adding attachments or perks

1. Build and test a deterministic resolver outside `WeaponSystem`.
2. Define typed channels and stacking/clamp policy before authoring content.
3. Add resolved revision/provenance to snapshots or replay state.
4. Apply resolved configuration without resetting unrelated runtime state.
5. Verify old in-flight projectiles retain their frozen launch values.
6. Extend load tests with representative combined sources.

## 19. Module map

| Module | Responsibility |
| --- | --- |
| `weapons/WeaponDefinition.ts` | weapon/fire-mode/command schema |
| `weapons/AmmunitionDefinition.ts` | ammunition data and kinetic energy helper |
| `weapons/WeaponHandling.ts` | handling context, flat modifier seam, cone formula |
| `weapons/WeaponSystem.ts` | weapon runtime, deterministic shot acceptance and events |
| `weapons/LoadoutSystem.ts` | equipment routing and switching |
| `weapons/weaponDefinitions.ts` | sniper/M4/Glock/SAW tuning |
| `core/WeaponAimComposer.ts` | local angular direction composition |
| `core/ScopeAdjustmentController.ts` | shared-model zeroing and windage |
| `combat/BallisticEnvironment.ts` | gravity, wind, fixed-step configuration |
| `combat/BallisticModel.ts` | shared velocity integration |
| `combat/BallisticProjectileSystem.ts` | pooled projectile simulation and results |
| `core/WorldQuery.ts` | analytic terrain and indexed collider seam |
| `combat/SurfaceProfile.ts` | material gameplay/effect definitions |
| `combat/PenetrationResolver.ts` | pure energy/thickness terminal model |
| `combat/Damageable.ts` | target health contract |
| `combat/ImpactEvent.ts` | immediate contact event |
| `combat/TargetHitReport.ts` | applied target damage report |
| `combat/ShotResult.ts` / `ShotTrace.ts` | completed outcome and reporting path |
| `WeaponPrototype.tsx` | transitional input/aim/projectile/presentation adapter |

## 20. Known limitations and deliberate next seams

- The drag curve is an approximation and ammunition tuning is provisional.
- Damage is whole-target health with an energy scale, not anatomical damage.
- Penetration is one homogeneous thickness per registered collider.
- There is no ricochet, deflection, fragmentation, spall, armor layering, or
  projectile radius.
- Weapon event/result arrays depend on timely draining; only impact events have
  a hard queue cap.
- Runtime snapshots are inspectable but not yet complete serialized save/rollback
  state.
- Modifier factors lack authored maximums because content resolution is not yet
  implemented.
- No attachment/perk should ship by calling `setHandlingModifiers` from random UI
  code. The deterministic resolver and revision contract in section 9 comes
  first.

These are visible engineering boundaries, not reasons to move authority into
React, GLTF animation, Rapier bullets, or presentation raycasts.
