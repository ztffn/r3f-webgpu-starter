---
phase: weapon-feature-fix
reviewed: 2026-08-02T00:00:00Z
depth: standard
files_reviewed: 19
files_reviewed_list:
  - docs/10-fps-combat-implementation-spec.md
  - docs/11-weapon-ballistics-and-modifier-system-spec.md
  - src/components/Hud.tsx
  - src/fps/WeaponPrototype.tsx
  - src/fps/combat/BallisticProjectileSystem.ts
  - src/fps/combat/HitscanResolver.ts
  - src/fps/combat/ShotTrace.ts
  - src/fps/core/FiringTimeline.ts
  - src/fps/core/WeaponAimComposer.ts
  - src/fps/presentation/ShotTrajectoryDebugView.tsx
  - src/fps/ui/CombatTelemetry.ts
  - src/fps/ui/WeaponAimIndicator.ts
  - src/fps/weapons/LoadoutSystem.ts
  - src/fps/weapons/WeaponSystem.ts
  - src/fps/weapons/developmentLoadout.ts
  - tests/fps/combat-telemetry.test.ts
  - tests/fps/combat.test.ts
  - tests/fps/firing-timeline.test.ts
  - tests/fps/weapon-systems.test.ts
prior_review: docs/reviews/2026-08-02-weapon-feature-REVIEW.md
prior_findings:
  CR-01: resolved
  CR-02: resolved
  WR-01: resolved
  WR-02: resolved
  WR-03: resolved
  WR-04: resolved
  WR-05: resolved
  WR-06: partially_resolved
findings:
  critical: 1
  warning: 5
  info: 6
  total: 12
status: addressed
resolution:
  CR-01N: fixed
  WR-01N: fixed
  WR-02N: deferred
  WR-03N: fixed
  WR-04N: fixed
  WR-05N: fixed
  IN-01: fixed
  IN-02: fixed
  IN-03: fixed
  IN-04: fixed
  IN-05: partially_fixed
  IN-06: fixed
---

## Resolution pass

Every finding below was worked after the review. Status as of the commits that
follow it; the full gate (`npm test` 80/80, `npm run typecheck`, `npm run build`)
passes on the resulting tree.

| Finding | Status | Commit | Note |
| --- | --- | --- | --- |
| CR-01N — dropped frame time freezes ADS/recoil/bloom | **fixed** | `467b411` | Every `advanceFiring` exit consumes the remainder through one shared step. Two tests added; the first fails if the fix alone is reverted. |
| WR-01N — overstated pose-reconstruction bound | **fixed** | `3a88f45` | Doc 10 now carries a measured table and states plainly that the path is not cadence-exact for arbitrary motion. A second test track sweeps both axes and locks the residual just above its measured worst case (3.3e-4 rad, 1.4 cm). |
| WR-02N — no test covers `WeaponPrototype.tsx` | **deferred** | — | Accurate. Closing it needs an R3F frame-host harness, which is a larger piece of work than this pass; recorded in doc 10 §10 rather than left implicit. The consolidation in `084d7af` removes the specific ordering trap the finding worried about. |
| WR-03N — `?ammo=` value can hard-crash the scene | **fixed** | `9666850` | All three externally keyed tables (`?ammo=`, `KeyboardEvent`, weapon id) now require an own property. Test covers `constructor`, `__proto__`, `toString`, `hasOwnProperty`. |
| WR-04N — skeleton textures leak; array-material null guard | **fixed** | `09a0b2d` | Skeletons collected and disposed, empty material slots skipped, and `uncacheRoot` now receives the root the mixer was built on. |
| WR-05N — "Ballistic CPU" no longer measures ballistics | **fixed** | `212aa98` | `FiringTimeline` accumulates its own solver time; the HUD reports "Sim CPU" and "Projectile CPU" as separate rows. |
| IN-01 — terminal telemetry naming | **fixed** | this commit | The interface now states that the group describes the round's last authored-surface contact plus a `stopped` flag, which is what the code does. |
| IN-02 — shooter-seed truncation collisions | **fixed** | `212aa98` | Requires a 32-bit integer, matching the coercion. |
| IN-03 — duplicated frame-start pose state | **fixed** | `084d7af` | One capture at the top of the frame feeds planar speed, sub-frame interpolation, and the weapon-lag impulse. Four refs removed. |
| IN-04 — "never zero" claim is reachable | **fixed** | `3a88f45` | Both specs now say a round accepted on the frame edge flies from the next frame. |
| IN-05 — switch quantization; cross-weapon ADS lerp | **partially fixed** | `084d7af` | The cross-weapon `adsProgress` interpolation is fixed. Putting `weapon-equipped` on the acceptance-offset timeline is left open: no shot can currently be accepted through that gap, and it is a contract change to `LoadoutEvent`. |
| IN-06 — dead memo and dependencies | **fixed** | `09a0b2d`, `212aa98` | Handlers passed inline; two unread effect dependencies dropped. |

Findings CR-01 and CR-02 from the prior review, and WR-01 through WR-06, remain
resolved — see the assessments below, which were written before this pass.

---

# Weapon Feature Fix Pass: Code Review Report

**Reviewed:** 2026-08-02
**Depth:** standard
**Files Reviewed:** 19
**Range:** `f9bbf1b..HEAD` on `plan/ecctrl-controller-spike`
**Status:** issues_found

## Summary

Seven of the eight prior findings are genuinely fixed, and the eighth (`WR-06`,
GPU teardown) is most of the way there. The `FiringTimeline` is real work: it
does walk accepted events chronologically, does advance sway and the projectile
solver to each acceptance boundary before spawning, and does resolve the scope
zero from the accepted round's own weapon. `npm run typecheck` is clean and
`npm test` reports 76/76 passing on this tree.

The pass is nevertheless not ready to ship. One blocker predates the pass but
sits directly on the invariant the pass introduces and documents: two return
paths in `WeaponSystem.advanceFiring` silently discard the rest of the frame's
simulation time, so `updateCursorSeconds` does not equal the time consumed and,
in the reachable case of a held trigger on an empty automatic weapon, ADS
progress, recoil recovery, and bloom recovery freeze completely. I reproduced
this: `adsProgress` stays at `0` after a full second of updates where an
identical weapon without the trigger held reaches `1`.

Four further warnings concern claims the pass makes that the code does not
support: doc 10 states a sub-frame pose-reconstruction bound that is wrong by
three orders of magnitude for an ordinary mouse movement (measured), the new
cadence test never touches `WeaponPrototype.tsx` — the file the original finding
named — the stricter definition validation turned a URL parameter into a hard
render crash, and the "Ballistic CPU" instrument now measures something other
than ballistics.

No security vulnerability was found. The one crash triggered by a URL parameter
(`NEW-04`) is a local-prototype robustness defect, not a boundary crossing.

## Prior finding resolution

### CR-01 — Accepted shots lose their cadence time and frozen player pose — **RESOLVED**

The described mechanism exists end to end.

- `WeaponEvent` of type `shot` now carries `acceptedAtOffsetSeconds`
  (`src/fps/weapons/WeaponSystem.ts:57`), populated from a per-update cursor at
  `src/fps/weapons/WeaponSystem.ts:454`, reset at both ends of `update()`
  (`:229`, `:231`).
- `FiringTimeline.runFrame` drains the frame's events, clamps each offset
  monotonically into `[cursor, delta]`, advances sway and the projectile solver
  to that boundary, resolves the shot, then continues; after the last event it
  advances both to the end of the frame
  (`src/fps/core/FiringTimeline.ts:137-167`).
- `resolveShot` interpolates the origin with `lerpVectors` and the base
  orientation with `slerpQuaternions` at `atSeconds / delta`, composes
  sight → turret-adjusted bore → dispersed projectile direction, and spawns
  (`src/fps/core/FiringTimeline.ts:199-247`).
- One clamped clock: the host computes `simulationDelta` once and feeds the same
  value to `loadout.update()` and `timelineFrame.deltaSeconds`
  (`src/fps/WeaponPrototype.tsx:757`, `:784`, `:800`); `FiringTimeline` re-clamps
  with the same function (`src/fps/core/FiringTimeline.ts:142`) and
  `MAX_SIMULATION_FRAME_SECONDS` is literally `WEAPON_UPDATE_MAX_SECONDS`
  (`src/fps/core/FiringTimeline.ts:20`).
- Per-round zeroing resolves from `event.weaponId`
  (`src/fps/core/FiringTimeline.ts:221-223`,
  `src/fps/WeaponPrototype.tsx:360-361`), so a mid-frame equip cannot apply
  another optic's zero.
- Gameplay sway now reads authoritative `adsProgress`, not the damped rig blend
  (`src/fps/WeaponPrototype.tsx:810-811`); the old
  `aimSway.update(delta, { adsBlend: aim.current })` call is gone.

I verified the scratch-aliasing concern rather than assuming it:
`WeaponAimComposer.composeQuaternion` opens with `target.copy(base)` and uses
separate `yawQuaternion`/`pitchQuaternion` scratch
(`src/fps/core/WeaponAimComposer.ts:19-21`), so the `target === base` calls at
`src/fps/core/FiringTimeline.ts:208-213` and
`src/fps/core/WeaponAimComposer.ts:38` are safe. `BallisticProjectileSystem.spawn`
clones every vector it is handed (`src/fps/combat/BallisticProjectileSystem.ts:203-255`),
so the reused `view` object cannot leak into a spawned shot.

Sub-frame slicing of the two continuous systems is mathematically sound:
`AimSwayController`'s exponential damp composes exactly over concatenated
intervals and `phaseSeconds` is additive, and
`BallisticProjectileSystem`'s fixed-step accumulator runs
`floor((total + eps) / step)` steps regardless of how the total was chunked. That
is why the stationary 30/60/144 Hz test holds to 1e-12.

Two caveats are recorded below as new findings rather than as a partial
resolution, because neither is the defect CR-01 described: `NEW-01` (the cursor
does *not* equal the time advanced on two `advanceFiring` return paths) and
`NEW-02`/`NEW-03` (the residual bound is overstated and the adapter itself is
untested).

### CR-02 — Completed telemetry combines aggregate, terminal, and target results — **RESOLVED**

`ShotTelemetry` is now structurally three groups: `ShotTargetTelemetry`
(sourced only from `result.report`), shot-wide aggregates
(`totalDamageApplied`, `damagedTargetCount`, `anyTargetDestroyed`), and
`ShotTerminalTelemetry` (`src/fps/ui/CombatTelemetry.ts:27-77`). `publishShot`
sources each group from its own object (`:193-257`), and the guard at `:201-205`
correctly refuses to treat a trailing `"penetrated"` interaction as the terminal
contact when a stopping impact exists — which also covers the degenerate
zero-speed resolve path in `BallisticProjectileSystem.handleImpact:456-459`,
where a stopping `hit` is produced with no interaction recorded at all.

The HUD consumes the split correctly: the row subject and every value beside it
come from `target`, terminal fields come from `terminal`, and the `status` class
no longer marks a surviving target "down" because an earlier one died
(`src/components/Hud.tsx:88-108`, `:192-212`).

Coverage matches what the finding asked for: target-then-terrain
(`tests/fps/combat-telemetry.test.ts:174-203`), target-then-expiry (`:205-229`),
and two damaged targets where only the first is destroyed (`:231-261`).

One residual semantic quirk is recorded as `NEW-07` (info).

### WR-01 — Multi-weapon shot sequences collide in React keys — **RESOLVED**

`shotTelemetryKey` and `impactTelemetryKey` combine identity with sequence
(`src/fps/ui/CombatTelemetry.ts:130-136`) and are used for both the recent-shot
rows and the hit marker (`src/components/Hud.tsx:76`, `:106`).
`ImpactTelemetry.sourceId` now exists (`src/fps/ui/CombatTelemetry.ts:86`) and is
populated from `ImpactEvent.sourceId` (`:263`). The requested test — sequence 1
from two different weapon ids — exists at
`tests/fps/combat-telemetry.test.ts:133-172`.

### WR-02 — The yellow "adjusted bore" line included random dispersion — **RESOLVED**

`BallisticShot.boreDirection` is an explicit optional input defaulting to
`direction` (`src/fps/combat/BallisticProjectileSystem.ts:24-29`, `:209-213`),
retained on `SpawnedBallisticShot` (`:38-44`, `:254`) and on the trace
(`src/fps/combat/ShotTrace.ts:18-24`,
`src/fps/combat/BallisticProjectileSystem.ts:640-642`). The debug view draws
`trace.boreDirection` (`src/fps/presentation/ShotTrajectoryDebugView.tsx:133-136`).
Hitscan collapses all three onto the supplied direction with an explanatory
comment (`src/fps/combat/HitscanResolver.ts:34-38`). The requested three-vector
assertion exists at `tests/fps/firing-timeline.test.ts:377-384`.

### WR-03 — Definition validation accepted values that break cadence and reload — **RESOLVED**

`validateDefinition` now checks every authored runtime number before any state
is assigned (`src/fps/weapons/WeaponSystem.ts:520-541`), using four typed
assertion helpers (`:110-132`), and additionally validates the referenced
ammunition's mass, muzzle velocity, ballistic coefficient, penetration
multiplier, and base damage (`:535-540`). The boundary tests requested by the
finding exist at `tests/fps/weapon-systems.test.ts:121-155`, including a
`doesNotThrow` sweep over every shipped definition.

This fix has an unintended side effect on external input — see `NEW-04`.

### WR-04 — A non-finite switch duration permanently wedges the loadout — **RESOLVED**

`requestEquip` rejects non-finite and negative durations at
`src/fps/weapons/LoadoutSystem.ts:85`, before `collectWeaponEvents`,
`previous.deactivate()`, the `weapon-switch-started` push, and both switch-state
assignments (`:86-92`). The test asserts `NaN`, both infinities, and `-1`, checks
that the snapshot and event queue are untouched, and then proves the loadout is
still usable (`tests/fps/weapon-systems.test.ts:493-521`).

### WR-05 — Default instance seeds were identical for every copy — **RESOLVED**

The constructor requires an integer `instanceSeed` and throws otherwise
(`src/fps/weapons/WeaponSystem.ts:183-193`); the `hashString32(definition.id)`
default is gone. `deriveWeaponInstanceSeed(shooterSeed, slotId, weaponId)`
provides the stable per-slot derivation (`:98-108`) and
`createDevelopmentLoadout(shooterSeed)` uses it
(`src/fps/weapons/developmentLoadout.ts:20-45`). The test proves replay
determinism for one shooter, four distinct seeds within a loadout, divergence
between shooters, and rejection of `NaN`/`1.5`
(`tests/fps/weapon-systems.test.ts:523-548`).

A truncation edge remains — see `NEW-08` (info).

### WR-06 — GLTF cleanup leaked texture resources and the replaced lens material — **PARTIALLY RESOLVED**

What is fixed: `disposeObject` now collects geometries and materials into sets so
each is disposed exactly once, collects textures from every disposed material,
excludes the preserved lens material and its textures, and accepts the
`replacedMaterials` list (`src/fps/WeaponPrototype.tsx:91-132`). The authored lens
material is captured before the swap (`:663-667`) and passed to teardown
(`:723`). The `!alive` early-return path calls `disposeObject(gltf.scene)` with
no preserved or replaced material, which is correct because the swap only
happens on the `alive` branch (`:642-645`). Cleanup ordering across the two
effects is also correct: the GLTF effect is declared first, so its cleanup runs
before `lensMaterial.dispose()` at `:1032`, and the preserved material survives
repeated rig reloads.

What is not fixed: skeleton bone textures and a lost null guard — see `NEW-05`.

## Critical Issues

### CR-01N — BLOCKER: two `advanceFiring` return paths discard the rest of the frame, freezing ADS and recovery

**File:** `src/fps/weapons/WeaponSystem.ts:386-398` (contract at `:227-232`, `:454`)

**Issue:** The pass introduces `updateCursorSeconds` with the documented contract
"the cursor makes every event emitted inside this call carry its exact
acceptance offset" (`:226-228`). On two of the five exits from `advanceFiring`
the cursor is not advanced *and* `advanceContinuousState` is never called for the
remaining time:

```ts
if (this.burstRoundsRemaining > 0) {
  if (!this.tryFireOnce()) {
    this.burstRoundsRemaining = 0;
    return;                      // <- `remaining` seconds silently dropped
  }
  this.burstRoundsRemaining -= 1;
} else if (this.activeFireMode === "auto" && this.triggerHeld && this.automaticArmed) {
  if (!this.tryFireOnce()) return; // <- `remaining` seconds silently dropped
}
```

Both `tryFireOnce()` failures at this point mean an empty magazine, because
`cooldownRemaining` was just driven to zero by `advanceContinuousState(toBoundary)`
and `reloadRemaining` is zero on this path.

For an automatic weapon this is not a one-frame rounding error, it is permanent.
Once the magazine empties, `cooldownRemaining` decays to zero within a few
frames; from then on every `update(dt)` enters the loop with `cooldownRemaining
=== 0`, takes `toBoundary = 0`, calls `tryFireOnce()`, fails, and returns having
advanced nothing at all. `advanceContinuousState` owns ADS progress, recoil
decay, and bloom decay, so all three stop.

Reproduced against this tree with the shipped SAW definition
(`magazineSize: 100`, 900 RPM, `auto`):

```
held trigger, empty mag, adsProgress after 1 s = 0
no trigger,   empty mag, adsProgress after 1 s = 1

recoil pitch at the moment the magazine empties: 0.04244 rad
after 10 s more with the trigger held:            0.03144 rad   (frozen)
after releasing the trigger for 1 s:              0.00035 rad
```

Player-visible consequence: hold fire on an empty SAW and press ADS, and the
weapon never enters ADS. Release the trigger and it snaps in. Recoil never
recovers while held.

It is also a cadence-equivalence violation on exactly the axis this pass
exists to guarantee. The amount of simulation time dropped on the frame where
the magazine empties is a function of frame length, so `adsProgress`,
`recoilPitchRadians`, and `bloomRadians` — and therefore the next shot's
dispersion cone — diverge between 30 Hz and 144 Hz. Neither
`tests/fps/firing-timeline.test.ts` nor `tests/fps/weapon-systems.test.ts`
exercises a dry automatic weapon across render rates, so the suite passes.

The underlying early return predates this pass. It is raised now because the
pass adopts, documents (`docs/11-...md:145-149`), and tests a contract it
violates, and because the fix is on the same lines.

**Fix:** Consume the frame on every exit. Make the cursor and the continuous
advance a single, unavoidable step:

```ts
private advanceFiring(dtSeconds: number): void {
  let remaining = dtSeconds;
  const finish = () => {
    this.advanceContinuousState(remaining);
    this.updateCursorSeconds += remaining;
    remaining = 0;
  };
  while (true) {
    if (this.cooldownRemaining > remaining + TIME_EPSILON) return finish();
    const toBoundary = this.cooldownRemaining;
    this.advanceContinuousState(toBoundary);
    this.updateCursorSeconds += toBoundary;
    remaining = Math.max(0, remaining - toBoundary);

    if (this.burstRoundsRemaining > 0) {
      if (!this.tryFireOnce()) {
        this.burstRoundsRemaining = 0;
        return finish();
      }
      this.burstRoundsRemaining -= 1;
    } else if (this.activeFireMode === "auto" && this.triggerHeld && this.automaticArmed) {
      if (!this.tryFireOnce()) return finish();
    } else {
      return finish();
    }
    if (remaining <= TIME_EPSILON) return;
  }
}
```

Add two tests: (1) an empty automatic weapon with the trigger held reaches
`adsProgress === 1` in the same number of seconds as one with the trigger
released, and recoil/bloom decay identically; (2) assert the invariant directly —
after any `update(dt)` that returns without an early exit, the sum of the
`advanceContinuousState` arguments equals the clamped `dt`. The cheapest form of
(2) is to expose the cursor on the snapshot and assert
`cursorAfterUpdate === clamp(dt)` across the burst-dry, auto-dry, reload, and
cooling paths.

## Warnings

### WR-01N — WARNING: doc 10 states a pose-reconstruction bound that is wrong by three orders of magnitude, and the test that cites it exercises a path `slerp` reproduces exactly

**Files:** `docs/10-fps-combat-implementation-spec.md:133-138`;
`tests/fps/firing-timeline.test.ts:76-88`, `:394-402`

**Issue:** Doc 10 claims two residuals survive sub-frame pose reconstruction,
"`THREE.Quaternion.slerp` carries roughly 2e-8 rad of numerical error on short
arcs, and a look path that is not a quaternion great circle bends away from the
interpolated one. Both are orders of magnitude below one 0.1 mrad turret click."
The second half is false for ordinary mouse movement, and the test that is
supposed to bound it cannot detect it.

The `MOVING_AND_TURNING` track rotates on a single axis:
`setFromEuler(new THREE.Euler(PITCH_RADIANS, BASE_YAW_RADIANS + rate * t, 0, "YXZ"))`
with `PITCH_RADIANS` constant. That is `Ry(yaw(t)) · Rx(pitch)`, a left
translation of a one-parameter subgroup — a quaternion great circle by
construction. `slerp` reproduces it exactly. Measured on this tree:

```
test track (yaw 0.6 rad/s, no pitch change, 33 ms frame): 3.33e-8 rad
20 deg yaw + 8 deg pitch in one 33 ms frame:              4.75e-4 rad = 0.475 mrad
90 deg yaw + 30 deg pitch in one 33 ms frame:             3.13e-2 rad = 31.3 mrad
```

So the "non-great-circle" residual the doc dismisses is roughly five turret
clicks for a modest combined-axis movement, and 313 clicks (1.8 degrees) for a
flick. It is also a real cross-rate divergence, which is the property this pass
claims: reconstructing one 90-degree/30-degree flick as a single 30 Hz frame
versus five 144 Hz frames gives spawn directions that differ by up to

```
3.08e-2 rad = 30.8 mrad = 6.17 m at 200 m
```

The `1e-6 rad` / `1e-3 m` tolerances at
`tests/fps/firing-timeline.test.ts:401` are fine for the track actually used —
they are 30x the pure floating-point residual — but they are attributed in the
comment to an error source the track never produces.

This is not an argument against interpolation; the host only observes frame
edges, so interpolation is the best reconstruction available. The defect is that
the spec asserts a quantitative bound that is not true and that nothing measures.

**Fix:** Either correct the doc to state the bound honestly (single-axis or
small-angle only; combined-axis movement above a few degrees per frame is not
cadence-equivalent), or add a track that actually bends. Concretely, add a third
`PoseTrack` whose yaw and pitch both sweep several degrees per 30 Hz frame, run
it through `assertCadenceEquivalence`, and set the tolerance from the measured
value rather than from the great-circle case:

```ts
const FLICKING: PoseTrack = {
  planarSpeedMetresPerSecond: 0,
  position: (_s, target) => target.copy(START_POSITION),
  orientation: (seconds, target) =>
    target.setFromEuler(
      new THREE.Euler(
        PITCH_RADIANS + 1.2 * seconds,   // both axes move
        BASE_YAW_RADIANS + 3.0 * seconds,
        0,
        "YXZ"
      )
    ),
};
```

### WR-02N — WARNING: no test covers `WeaponPrototype.tsx`, the adapter CR-01 actually named

**Files:** `src/fps/WeaponPrototype.tsx:754-856`;
`tests/fps/firing-timeline.test.ts:123-205`

**Issue:** CR-01 was filed against `src/fps/WeaponPrototype.tsx:729-866` and asked
for "an integration test around the adapter/timeline". What shipped is a test of
`FiringTimeline` in isolation driven by a hand-written host loop (`runCadence`)
that is not the real host and differs from it in ways that matter:

| `runCadence` | `WeaponPrototype` |
| --- | --- |
| `loadout.update(delta)`, `frame.deltaSeconds = delta`, no clamp | both fed `clampSimulationDelta(delta)` |
| `startPosition` sampled exactly at `frameStart` from the track | previous frame's end pose, written after `runFrame` at `:818-819` |
| `adsProgressStart/End` pinned to `0` | read either side of `loadout.update` at `:783`/`:811` |
| one weapon, one `SIGHT_ADJUSTMENT` | four weapons, `scopeAdjustments.get(weaponId)` map |
| `swayHandlingMultiplier = 1` | `weaponSnapshot.swayFactor` |
| `captureTrace = false` | `FPS_DEBUG.shotTrajectory` |

Reverting `WeaponPrototype` to an end-of-frame pose while leaving
`FiringTimeline` intact would not fail a single test. The frame-ordering
properties the review cared about — that `simulationStartPosition` is written
after `runFrame`, that `drainResults` runs after the timeline, that
`adsProgressBefore` is captured before `loadout.update` — are all unguarded.

Two smaller test-quality notes in the same area: `runCadence`'s `onShot` visitor
never provides `onEvent`, so dry-fire and equip ordering through the timeline is
untested; and
`tests/fps/combat-telemetry.test.ts:189`
(`assert.equal(shot.target.damageApplied, shot.totalDamageApplied)`) is trivially
true in a one-target scenario and carries no signal — the real assertion of that
property is the two-target case at `:255-258`.

**Fix:** Extract the frame body's gameplay half into a testable pure function —
something like `runWeaponFrame(deps, state, { delta, cameraPosition,
cameraQuaternion, stance, grounded, commands })` — leave only Three.js/React
plumbing in `useFrame`, and drive that function at 30/60/144 Hz in a test.
Failing that, at minimum assert the ordering contract directly with a spy host
that records the sequence of `loadout.update`, `runFrame`, `drainResults`, and
the two `simulationStart*` writes.

### WR-03N — WARNING: an `?ammo=` URL value can now hard-crash the scene during render

**Files:** `src/fps/weapons/AmmunitionDefinition.ts:55-58`;
`src/fps/weapons/WeaponSystem.ts:528`, `:535-540`;
`src/fps/WeaponPrototype.tsx:235-257`

**Issue:** `ammunitionFromSearch` indexes a plain object literal with an
unvalidated query-string value:

```ts
const requested = new URLSearchParams(search).get("ammo") as AmmunitionId | null;
return (requested && AMMUNITION_DEFINITIONS[requested]) || DEFAULT_AMMUNITION;
```

`AMMUNITION_DEFINITIONS` inherits from `Object.prototype`, so `?ammo=constructor`
returns the `Object` function, `?ammo=__proto__` returns `Object.prototype`, and
`?ammo=toString` returns a function — all truthy, so the `|| DEFAULT_AMMUNITION`
fallback never fires. The resulting "ammunition" has `baseDamage === undefined`.

Before this pass that degraded quietly: `validateDefinition` did not check
`shot.damage` or ammunition fields, and `BallisticProjectileSystem.spawn` simply
rejected each round. WR-03's new assertions turn it into a throw
(`assertFiniteNonNegative(definition.shot.damage, ...)`), and that throw happens
inside `useMemo` during render (`src/fps/WeaponPrototype.tsx:254-257`). There is
no `ErrorBoundary` anywhere in `src/`, so the scene blanks. Verified against this
tree:

```
?ammo=constructor -> THROWS: Weapon prototype-sniper needs a finite non-negative shot damage
?ammo=__proto__   -> THROWS: Weapon prototype-sniper needs a finite non-negative shot damage
?ammo=toString    -> THROWS: Weapon prototype-sniper needs a finite non-negative shot damage
```

This is a local dev prototype with no untrusted input path, so it is a
robustness defect rather than a vulnerability — but the same unguarded-lookup
shape appears at `src/fps/core/ScopeAdjustmentController.ts:67`
(`DEFAULT_SCOPE_BINDINGS[event.code] ?? KEY_FALLBACKS[event.key]`), which is fed
directly from `KeyboardEvent`, and at
`src/fps/presentation/WeaponPresentationDefinition.ts:50`.

**Fix:** Make the lookup own-property-only, and prefer `null`-prototype tables
for anything keyed by external input:

```ts
export function ammunitionFromSearch(search: string): AmmunitionDefinition {
  const requested = new URLSearchParams(search).get("ammo");
  if (requested !== null && Object.hasOwn(AMMUNITION_DEFINITIONS, requested)) {
    return AMMUNITION_DEFINITIONS[requested as AmmunitionId];
  }
  return DEFAULT_AMMUNITION;
}
```

Apply the same guard to `scopeAdjustmentActionForKey` and
`weaponPresentationFor`. Add a test asserting that `?ammo=constructor`,
`?ammo=__proto__`, and `?ammo=toString` all return `DEFAULT_AMMUNITION`.

### WR-04N — WARNING: rig teardown still leaks skeleton bone textures, and the array-material branch lost its null guard

**File:** `src/fps/WeaponPrototype.tsx:105-132` (call sites `:643`, `:723`)

**Issue:** Two gaps remain in the WR-06 fix.

1. **Skeleton bone textures are never released.** The rig is skinned — the code
   says so at `:672-673` ("SCOPE_Lens is skinned: its Object3D origin remains at
   the rifle root while only its vertices follow the weapon bones"). Three
   allocates a `DataTexture` of bone matrices per `Skeleton`
   (`three/src/objects/Skeleton.js:259-263`) and releases it only in
   `Skeleton.dispose()` (`:298-303`). `disposeObject` traverses for
   `mesh.geometry` and `mesh.material` and never touches `SkinnedMesh.skeleton`,
   so every rig load leaks one float `DataTexture` per skeleton. Given the
   presentation-switching seam this teardown was hardened for, that leak repeats
   per swap.

2. **The array-material branch has no null guard, unlike the single branch:**

   ```ts
   if (Array.isArray(material)) for (const item of material) materials.add(item);
   else if (material) materials.add(material);   // guarded
   ```

   A sparse or partially-undefined material array puts `undefined` into the set;
   `collectTextures(undefined, ...)` then throws on `Object.values(undefined)` at
   `:92`, inside the loop at `:124-127`. Because the throw escapes
   `disposeObject`, none of the geometries (`:128`) or textures (`:129-131`)
   are disposed, and the rest of the cleanup function (`replacedMaterials.length
   = 0`, `rig.clear()` at `:724-725`) never runs. One malformed mesh turns a
   partial leak into a total one.

**Fix:**

```ts
const skeletons = new Set<THREE.Skeleton>();
root.traverse((object) => {
  const mesh = object as THREE.Mesh & { isSkinnedMesh?: boolean; skeleton?: THREE.Skeleton };
  if (mesh.geometry) geometries.add(mesh.geometry);
  if (mesh.isSkinnedMesh && mesh.skeleton) skeletons.add(mesh.skeleton);
  const material = mesh.material;
  if (Array.isArray(material)) {
    for (const item of material) if (item) materials.add(item);
  } else if (material) materials.add(material);
});
// ... after materials/geometries/textures:
for (const skeleton of skeletons) skeleton.dispose();
```

While in this function: `mixer.current?.uncacheRoot(rig)` at `:717` passes the
wrong root — the mixer was constructed on `gltf.scene` (`:682`), not `rig`. It is
harmless today because the mixer instance is dropped immediately afterwards, but
it is misleading and will silently do nothing if the mixer is ever reused.

### WR-05N — WARNING: the "Ballistic CPU" instrument no longer measures ballistics

**Files:** `src/fps/WeaponPrototype.tsx:815-826`; `src/components/Hud.tsx:267-271`;
`src/fps/ui/CombatTelemetry.ts:101-110`;
`docs/11-weapon-ballistics-and-modifier-system-spec.md:679-690`

**Issue:** The timed span moved. It used to wrap `ballistics.update(delta)`
alone; it now wraps the whole `firingTimeline.runFrame(...)` call:

```ts
const simulationStartedAt = performance.now();
firingTimeline.runFrame(timelineFrame, loadout, timelineHandlers);
const simulationMilliseconds = performance.now() - simulationStartedAt;
```

`runFrame` includes sway integration, per-boundary pose interpolation, three
quaternion compositions and a turret solve per round, `BallisticProjectileSystem.spawn`
allocations, and every `onShot`/`onEvent` handler — which in this host means
`playSegment()` (animation cross-fades) and `combatTelemetry` publishes that
notify every HUD subscriber. The value is still published as
`ProjectilePerformanceTelemetry.simulationMillisecondsPerFrame` and still
rendered under the label "Ballistic CPU", and doc 11 §16 still presents the
performance table as the projectile budget. The number that dials in the
projectile solver now silently includes presentation work.

`performance.now()` is also called twice per frame regardless of whether the
sample window has elapsed, and it is the only remaining reason the timing exists
at all.

**Fix:** Either time only the projectile work by having `FiringTimeline`
accumulate the time it spends inside `ballistics.update`/`ballistics.spawn` and
expose it, or rename the field and the HUD label to `gameplaySimulation…` /
"Gameplay CPU" and update the doc-11 budget row to say what it covers. Splitting
it is more useful: report projectile milliseconds and timeline-overhead
milliseconds separately, so a regression in either is attributable.

## Info

### IN-01 — `ShotTerminalTelemetry` describes the last surface, not where the round finished, when it expires past a penetration

**File:** `src/fps/ui/CombatTelemetry.ts:42-48`, `:201-235`
(asserted by `tests/fps/combat-telemetry.test.ts:225-228`)

The comment above the guard says a trailing `"penetrated"` interaction "belongs
to an earlier surface and must not describe the terminal contact", but the guard
only applies when `impact !== null`:

```ts
const terminalInteraction = impact
  ? lastInteraction?.outcome === "stopped" ? lastInteraction : null
  : lastInteraction;
```

When the round penetrates a surface and then expires in mid-air, `impact` is
`null` and the trailing `"penetrated"` interaction *is* used, so
`terminal.penetrationOutcome === "penetrated"`, `terminal.point` is the surface
rather than the expiry position, and `terminal.metres` is `null` — while the
interface doc for `ShotTerminalTelemetry` reads "Where the round finished."
`stopped: false` does disambiguate it for a careful reader, and the test locks
the behaviour in, so this is a naming/documentation mismatch rather than a bug.

**Fix:** Rename the group to `lastContact`, or add the actual expiry point and
distance and keep `terminal` meaning what its comment says.

### IN-02 — `deriveWeaponInstanceSeed` truncates its shooter seed, so distinct seeds can collide

**File:** `src/fps/weapons/WeaponSystem.ts:98-108`

`Number.isFinite(shooterSeed)` is the only guard, but the value is then coerced
with `shooterSeed >>> 0`. Shooter seeds `1`, `1.5`, `1.9`, and `4294967297` all
produce byte-identical loadouts. Given the function's stated purpose ("two
shooters given different seeds never share one"), the guard should match the
coercion.

**Fix:** `if (!Number.isInteger(shooterSeed)) throw new Error(...)`, and document
that the seed space is 32-bit.

### IN-03 — Duplicated frame-start pose state written at two different points in the frame

**File:** `src/fps/WeaponPrototype.tsx:773`, `:818-819`, `:927`

`previousPlayerPosition` is written at `:773`, *before* `loadout.update` and the
timeline; `simulationStartPosition` is written at `:818`, *after* the timeline.
`previousCameraQuaternion` (`:927`) and `simulationStartQuaternion` (`:819`) are
likewise the same value captured at two points. They agree today only because
nothing between those lines mutates `camera.position` or `camera.quaternion`. The
moment a camera recoil kick or a hit-reaction is added inside this callback, the
planar-speed reference and the timeline's frame-start pose will silently
disagree, and the timeline will interpolate from a pose the player was never in.

**Fix:** Capture the frame's start pose once into a single pair of vectors at the
top of the callback and derive both consumers from it.

### IN-04 — Docs claim a projectile "never" receives zero post-boundary time, but a boundary can land exactly on the frame edge

**Files:** `docs/10-fps-combat-implementation-spec.md:127-129`;
`docs/11-weapon-ballistics-and-modifier-system-spec.md:145-148`;
`src/fps/core/FiringTimeline.ts:154-165`

`advanceFiring`'s guard is `cooldownRemaining > remaining + TIME_EPSILON`, so a
cadence boundary that coincides exactly with the end of the frame is taken, and
the round is emitted with `acceptedAtOffsetSeconds === dt`. `runFrame` then clamps
it to `delta` and the final `advance` step is `0`. This is reachable in the
project's own tests: the reload branch of
`tests/fps/weapon-systems.test.ts:445-490` accepts its third round at exactly
`dt`. The behaviour is correct — the round simply starts flying next frame — but
it contradicts "never zero".

**Fix:** Change the wording to "never time that elapsed before the trigger
command; a round accepted exactly at the frame edge begins its flight in the
following frame."

### IN-05 — Weapon-switch completion is still quantized to whole frames, and ADS progress can be lerped between two weapons

**Files:** `src/fps/weapons/LoadoutSystem.ts:97-107`;
`src/fps/WeaponPrototype.tsx:783`, `:810-811`

`LoadoutSystem.update` decrements `switchRemaining` by the whole frame delta and
calls `finishSwitch()` before any weapon updates, so equip completion moves by up
to one frame between 30 Hz and 144 Hz, and the newly equipped weapon then
receives the full frame delta as if it had been equipped since `t = 0`. No shot
can currently be accepted through that gap (the new weapon's `triggerHeld` is
`false` and `handleCommand` refuses while `switchingTo` is set), so this is not a
correctness bug today — but it is the one remaining place where a gameplay
transition is not on the timeline the pass introduces.

Relatedly, on the frame a switch completes, `adsProgressBefore` (`:783`) is read
from the outgoing weapon while `adsProgressEnd` (`:811`) is read from the
incoming one, so gameplay sway interpolates its amplitude between two unrelated
ADS states for one frame.

**Fix:** Give `weapon-equipped` an acceptance offset like `shot` has, and clamp
`adsProgressStart` to the incoming weapon's own value when the equipped weapon
changed during the update.

### IN-06 — Extraneous dependencies and a pointless memo left by the refactor

**File:** `src/fps/WeaponPrototype.tsx:467-470`, `:727`

`timelineHandlers` is memoized (`:467-470`) but `runFrame` takes the handlers as
a per-call argument, so its identity is never compared to anything; the memo has
no effect. The GLTF effect's dependency array still lists `aimOffset` and
`opticLocal` (`:727`), which the effect body no longer references — the comment
at `:676-678` explains that the frame loop recomputes them, so the load-time use
was removed but the deps were not. Both are stable memos, so nothing misbehaves;
they are stale signal that will mislead the next reader about what the effect
depends on.

**Fix:** Pass `{ onShot: handleAcceptedShot, onEvent: handleWeaponEvent }` inline
and drop the two dead dependencies.

---

_Reviewed: 2026-08-02_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
_Gates run on this tree: `npx tsc --noEmit` clean; `npm test` 76/76 pass_
