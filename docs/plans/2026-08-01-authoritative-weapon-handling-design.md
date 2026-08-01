# Authoritative weapon handling design

## Goal

Add simple, deterministic weapon spread and recoil that make stance, movement,
ADS, and controlled bursts matter without turning the weapon layer into a
physics simulation. A shot must follow the same weapon state shown by the
reticle or hipfire crosshair, and the result must remain identical when the
same command timeline is advanced at 30, 60, or 144 Hz.

This design extends the data-driven sniper, M4, Glock, and SAW work. It does not
add authored weapon assets, an attachment inventory, stamina, suppression, or
network transport.

## Research basis

The selected model combines a few proven milsim ideas without reproducing their
full complexity:

- [Squad's Infantry Combat Overhaul](https://www.joinsquad.com/archive/infantry-combat-overhaul-10b70)
  treats point fire as weapon misalignment and lets movement, stance, stamina,
  and recoil change the weapon's stability instead of applying arbitrary
  screen-centred hipfire randomness.
- [Arma 3 weapon sway and fatigue](https://dev.arma3.com/post/oprep-weapon-sway-fatigue)
  separates breathing and grip forces and makes crouch and prone progressively
  steadier.
- [Arma 3 recoil configuration](https://community.bistudio.com/wiki/Arma_3%3A_CfgRecoils)
  models biased pitch/yaw impulses and distinguishes permanent displacement
  from temporary motion.
- [Arma Reforger weapon configuration](https://community.bistudio.com/wiki/Arma_Reforger%3AWeapon_Creation/Prefab_Configuration)
  keeps mechanical dispersion in weapon/ammunition data, while
  [attachment modifiers](https://community.bistudio.com/wiki/Arma_Reforger%3AWeapon_Stats-Modifing_Attachments)
  multiply named accuracy and recoil channels.
- Hurtworld's archived
  [recoil design](https://forum.alkad.org/threads/hurtworld-devblog-47.1576/)
  and [sub-frame firing follow-up](https://forum.alkad.org/threads/hurtworld-devblog-56.1687/)
  use deterministic per-shot variation, movement/stance accuracy factors, and
  cadence-aware recoil rather than render-frame shot counting.
- The [LlamAcademy data-driven gun example](https://github.com/llamacademy/scriptable-object-based-guns)
  supports configuration-driven spread, recoil, attachments, and crosshair
  feedback. Its Unity-specific object model is not carried into this runtime.

## Chosen model

Weapon handling has four additive angular layers:

```text
camera aim + authoritative sway
  + recoil remaining from earlier accepted shots
  = mean sight direction shown to the player

scope zero / windage adjustment of mean sight direction
  + deterministic sample from the current dispersion cone
  = accepted projectile direction

accept shot
  -> apply this shot's recoil impulse and bloom for later shots
```

The current shot captures recoil state before its own impulse. Its impulse can
therefore affect later rounds in the same burst, including rounds accepted at
multiple cadence boundaries inside one render frame, but can never bend the
shot that caused it.

The dispersion cone is the sum of:

1. **Mechanical dispersion:** a small weapon-authored grouping limit. It does
   not improve merely because the player goes prone.
2. **Handling error:** hipfire, planar movement, grounded state, stance, ADS,
   and breath stabilization. This is where running differs most from prone.
3. **Bloom:** a bounded continuous-fire penalty added once per accepted shot
   and recovered in simulation time.

Recoil is a weapon-authored pitch/yaw impulse plus a small deterministic yaw
bias. The gameplay offset recovers more slowly than the existing fast visual
kick, so bursts have persistent climb while the proxy rig can still settle
smoothly. There is no long recoil-pattern texture or unbounded shot history.

## Data contracts

`WeaponDefinition` gains server-safe numeric handling data. Initial values are
provisional tuning, expressed in radians:

```ts
interface WeaponAccuracyDefinition {
  mechanicalDispersionRadians: number;
  hipDispersionRadians: number;
  movementDispersionRadians: number;
  airborneDispersionRadians: number;
  bloomPerShotRadians: number;
  maxBloomRadians: number;
  bloomRecoveryPerSecond: number;
}

interface WeaponRecoilDefinition {
  pitchRadians: number;
  yawRadians: number;
  recoveryPerSecond: number;
  maxPitchRadians: number;
  maxYawRadians: number;
}
```

The existing `recoil` field becomes `WeaponRecoilDefinition`; `accuracy` is a
new field. Definitions contain no asset paths, Three.js types, callbacks, or
random generators.

The controller-to-weapon seam is a reusable plain-data snapshot:

```ts
interface WeaponHandlingContext {
  stance: "stand" | "crouch" | "prone";
  grounded: boolean;
  planarSpeedMetresPerSecond: number;
  breathStabilization: number;
}
```

`adsProgress` remains weapon-owned. The current camera motor does not expose
instantaneous velocity, so the transitional `WeaponPrototype` adapter measures
horizontal position delta into a reused scalar. A later ecctrl/Rapier motor
will supply authoritative planar speed through the same context rather than
making `WeaponSystem` read keys or physics bodies.

Future attachments resolve to one flat numeric modifier set before simulation:

```ts
interface WeaponHandlingModifiers {
  dispersionFactor: number;
  recoilPitchFactor: number;
  recoilYawFactor: number;
  recoilRecoveryFactor: number;
  bloomPerShotFactor: number;
  bloomRecoveryFactor: number;
  swayFactor: number;
}
```

This slice uses an all-ones default and implements no attachment slots. A
future loadout layer may combine modifiers in deterministic slot order without
changing the weapon update or shot event meaning.

## Runtime and deterministic sampling

`WeaponSystem` owns recoil pitch/yaw, bloom, the last handling context, and a
32-bit instance seed. The constructor accepts an optional numeric seed; the
definition ID supplies a stable fallback for local prototypes. A future
authority derives the seed from player and weapon-instance identity and
replicates that identity, not random samples.

Each shot hashes the instance seed with the monotonically increasing shot
sequence and derives two unit values. An allocation-free uniform-area disk
sample becomes pitch/yaw dispersion within the current cone. Randomness never
uses render time, `Math.random`, array history, or visual frame count.

Recovery is exponential and evaluated for every simulation-time interval
crossed by `WeaponSystem.update`. The cadence loop first recovers recoil and
bloom up to a firing boundary, accepts the shot using that boundary's state,
applies the new impulse, and continues through any remaining interval. This is
necessary for a 900 RPM weapon to accept and resolve several distinct rounds
after a slow render frame.

Reloading and unequipped weapons continue to recover recoil and bloom. Reload,
equipment switching, and fire-mode changes retain their existing burst
cancellation rules, but none resets handling state as an accuracy exploit.
The existing 100 ms hitch clamp remains the maximum accepted update interval.

Shot events add the local angular offsets captured at acceptance:

- mean recoil pitch/yaw before this shot's impulse;
- sampled dispersion pitch/yaw;
- recoil impulse pitch/yaw for presentation.

Snapshots expose current recoil, bloom, and total cone radius. Event and
snapshot fields are numbers and strings only, so commands and runtime state
remain snapshot/replay friendly.

## Initial tuning policy

The first pass uses these concrete values. They are gameplay starting points,
not claims about laboratory weapon accuracy. Values shown as mrad are stored as
radians (`1 mrad = 0.001 rad`).

| Weapon | mechanical | hip | movement | airborne | bloom / shot | bloom cap | bloom recovery | recoil pitch / yaw | recoil recovery | recoil pitch / yaw cap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Sniper | 0.25 | 6.0 | 8.0 | 12.0 | 0.4 | 2.0 | 7.0/s | 18 / 4 | 7.0/s | 45 / 15 |
| M4 | 0.45 | 8.0 | 10.0 | 14.0 | 1.1 | 7.0 | 5.5/s | 9 / 3 | 5.5/s | 45 / 15 |
| Glock | 1.50 | 10.0 | 12.0 | 16.0 | 1.0 | 5.0 | 7.0/s | 12 / 4 | 7.0/s | 36 / 15 |
| SAW | 0.70 | 10.0 | 14.0 | 18.0 | 1.4 | 10.0 | 4.5/s | 11 / 4 | 4.5/s | 65 / 22 |

Handling uses one allocation-free formula:

```text
speed01 = clamp(planarSpeed / 5.5 m/s, 0, 1)
adsFactor = lerp(1.0, 0.12, adsProgress)
breathFactor = lerp(1.0, 0.75, breathStabilization * adsProgress)
stanceFactor = stand 1.00 | crouch 0.62 | prone 0.30

groundedHandling =
  (hip * adsFactor + movement * speed01) * stanceFactor * breathFactor

standMovingBaseline = (hip * adsFactor + movement) * breathFactor

handling = grounded
  ? groundedHandling
  : max(groundedHandling + airborne, standMovingBaseline)

coneRadius =
  (mechanical + handling) * dispersionFactor + currentBloom
```

Bloom increments already include `bloomPerShotFactor`, so the final cone does
not apply that modifier twice. Recoil impulses are capped after their pitch/yaw
modifiers are applied. Recovery uses the authored response multiplied by the
corresponding recovery modifier.

The implementation must also obey these relationships:

| Condition | Required relationship |
|---|---|
| stationary crouch | less handling error than stationary stand |
| stationary prone | less handling error than stationary crouch |
| moving/running | more handling error than stationary in the same stance |
| airborne | no steadier than grounded standing movement |
| ADS | much less handling error than hipfire, but not zero mechanical dispersion |
| held breath while ADS | lowers handling error; it does not erase bloom or recoil |
| sustained automatic fire | bloom rises to a fixed cap |
| pause | recoil and bloom recover monotonically in simulation time |

Stance multipliers start with the existing sway values: stand `1.00`, crouch
`0.62`, prone `0.30`. Planar speed is normalized against an authored reference
run speed and clamped to `[0, 1]`. Invalid context values are clamped to safe
finite ranges. Invalid negative, non-finite, or internally inconsistent weapon
tuning fails definition validation in the constructor.

## Aim composition and presentation

`WeaponPrototype` composes directions in local angular space without allocating
per shot:

1. camera rotation plus `AimSwayController` produces the base sightline;
2. the event's pre-shot recoil rotates that sightline into the shot's mean
   direction;
3. scope elevation/windage adjusts the mean direction into mean bore;
4. the event's dispersion sample rotates mean bore into projectile direction;
5. `BallisticProjectileSystem.spawn` captures the final vectors.

The end-of-frame scope camera and weapon rig use the current recoil snapshot,
so the player sees the state that will affect the next shot. The existing fast
proxy-rig kick remains presentation-only and consumes recoil impulse fields; it
does not feed gameplay back through bones or camera transforms.

A compact hipfire crosshair is presentation, not authority. Its centre projects
the current mean sight direction, and its arm radius represents the current
bounded dispersion cone. It expands with movement and bloom, contracts with
stance/recovery, fades while ADS becomes active, and can be disabled with a
debug query option. A mutable FPS UI store is written from the frame host; the
crosshair updates DOM/SVG properties directly from `requestAnimationFrame`
without a React state update per render frame. It never generates a shot
direction.

## Frame order

The current FPS frame contract becomes:

```text
advance existing projectiles and drain completed events
sample controller pose, planar speed, stance, grounded state, and breath
set the equipped weapon's handling context
consume ordered weapon commands
advance loadout cadence, recovery, reload, and ADS
advance authoritative sway
derive base optical sightline
compose current mean direction for scope/crosshair presentation
drain accepted shot events
  -> compose each event's captured recoil and dispersion offsets
  -> spawn each projectile
update mixer and cosmetic recoil
render scope/world/weapon passes
```

The handling context must be set before a `triggerDown` command because semi,
burst, and auto can accept their first round immediately while handling the
edge. An event captures all local offsets needed to reproduce its direction;
later shots in the same render frame do not all inherit the final snapshot.

## Performance and bounded behavior

The hot path adds a few scalar clamps, exponential recovery operations per
cadence interval, and two deterministic random samples per accepted shot. It
adds no projectile bodies, per-tick objects, pattern arrays, or retained shot
history. Scratch vectors and quaternions in `WeaponPrototype` are reused.

Event queues remain bounded operationally by draining every update. The
32-system load test continues to drain shot, reload, dry-fire, and mode events
while also consuming recoil/dispersion fields. It reports CPU time and event
counts but does not assert a machine-specific millisecond budget.

## Verification and acceptance

Automated tests must prove:

- identical seeds and command timelines produce identical shot offsets;
- different instance seeds do not make every shooter share one pattern;
- a shot's own recoil impulse does not change that shot's accepted direction;
- later burst/auto rounds include prior recoil and increasing bounded bloom;
- stand, crouch, prone, moving, airborne, ADS, and breath inputs obey the
  tuning relationships above;
- recoil and bloom recover monotonically and do not reset on mode changes;
- 30, 60, and 144 Hz timelines at 600 and 900 RPM produce equivalent event
  sequences, offsets, final ammo, recoil, bloom, and reload state;
- 32 complete weapon/loadout systems still deplete ammunition, dry-fire,
  reload, resume firing, and drain all event types without retained history.

Human acceptance checks are deliberately short: compare stationary stand,
crouch, and prone; run and fire the M4; hold the SAW test definition through
bloom; fire short bursts and watch recovery; verify the hipfire crosshair
tracks those changes and fades in ADS; verify projectile impacts remain
consistent with the displayed mean and cone.

## Deferred work

- authored recoil-pattern textures and weapon-specific animation curves;
- stamina, injury, suppression, bipods, leaning, and supported-fire detection;
- attachment inventory, slot validation, UI, persistence, and replication;
- camera punch that modifies player view rotation;
- third-person recoil animation and remote-client reconstruction;
- final tuning based on real weapon models, animations, sound, and playtests.
