---
phase: weapon-feature
reviewed: 2026-08-01T23:14:16Z
depth: standard
files_reviewed: 21
files_reviewed_list:
  - src/components/Hud.tsx
  - src/fps/WeaponPrototype.tsx
  - src/fps/core/AimSwayController.ts
  - src/fps/core/LocalPlayerController.ts
  - src/fps/core/PlayerMotor.ts
  - src/fps/core/WeaponAimComposer.ts
  - src/fps/debug/debugConfig.ts
  - src/fps/presentation/ShotTrajectoryDebugView.tsx
  - src/fps/presentation/WeaponPresentationDefinition.ts
  - src/fps/ui/CombatTelemetry.ts
  - src/fps/ui/HipfireCrosshair.tsx
  - src/fps/ui/WeaponAimIndicator.ts
  - src/fps/weapons/LoadoutSystem.ts
  - src/fps/weapons/WeaponDefinition.ts
  - src/fps/weapons/WeaponHandling.ts
  - src/fps/weapons/WeaponSystem.ts
  - src/fps/weapons/developmentLoadout.ts
  - src/fps/weapons/weaponDefinitions.ts
  - tests/fps/aim-sway.test.ts
  - tests/fps/weapon-aim.test.ts
  - tests/fps/weapon-systems.test.ts
findings:
  critical: 2
  warning: 6
  info: 0
  total: 8
status: resolved
resolved_by: docs/reviews/2026-08-02-weapon-feature-fix-REVIEW.md
---

> **All eight findings in this report are fixed.** The follow-up review at
> `docs/reviews/2026-08-02-weapon-feature-fix-REVIEW.md` verifies each one
> against the code and records the further findings that pass produced. Keep
> this document as the original statement of the defects.

# Weapon Feature: Code Review Report

**Reviewed:** 2026-08-01T23:14:16Z
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

The weapon runtime has useful unit coverage and all automated gates passed (`npm test`: 63/63, `npm run typecheck`, and `npm run build`). The submitted feature is nevertheless not ready to ship. The R3F adapter discards the cadence time associated with accepted shots and resolves all events drained in one frame from one end-of-frame pose. This breaks the documented render-cadence equivalence at the actual trigger-to-projectile boundary. Completed-shot telemetry also combines aggregate, terminal-contact, and last-target fields into one record, producing false target reports after penetration.

Six additional robustness and presentation defects affect multi-weapon HUD identity, trajectory diagnostics, authored-data validation, switching lifecycle, deterministic instance seeding, and GPU resource cleanup. No security vulnerability was found in the reviewed browser-local surface.

## Critical Issues

### CR-01 — BLOCKER: Accepted shots lose their cadence time and frozen player pose in the frame adapter

**File:** `src/fps/WeaponPrototype.tsx:729-866`

**Issue:** `LoadoutSystem.update(delta)` may accept one or more rounds at exact cadence boundaries, but `WeaponEvent` carries no boundary offset, origin, base aim, or scope-adjustment revision. After the entire weapon update, the adapter advances sway once to the end of the render frame (lines 809-814), calculates one `authoritativeAimQuaternion` (lines 831-845), and drains every accepted event through that same quaternion and `player.aim.origin` (lines 381-412 and 864-866). All rounds accepted during one frame therefore spawn simultaneously from the end-of-frame position/base aim; only their local recoil and dispersion differ.

This produces different projectile directions and impact wall times at 30, 60, and 144 Hz when the player is moving, looking, or swaying, and it collapses multiple rounds crossed during a long frame onto one origin/time. The existing cadence test in `tests/fps/weapon-systems.test.ts:550-588` compares only weapon-local event offsets and final handling state, so it cannot detect the adapter error. The separate projectile cadence test likewise begins from already-frozen launch data. This contradicts the feature's documented claim that accepted directions and outcomes are equivalent across ordinary render cadences.

**Fix:** Put weapon acceptance, pose/aim sampling, and projectile spawning on one simulation timeline. At minimum, carry the accepted offset within the update plus a frozen origin/base-sight/turret revision on each event, process events chronologically, and advance each spawned projectile only through the part of the frame after its acceptance boundary. For example:

```ts
interface AcceptedShotEvent {
  readonly acceptedAtSeconds: number;
  readonly origin: ReadonlyVector3;
  readonly baseSightDirection: ReadonlyVector3;
  readonly scopeAdjustmentRevision: number;
  // existing recoil/dispersion/launch fields...
}

loadout.update(delta, (boundary, weapon) => {
  playerAimHistory.sample(boundary, frozenPose);
  weapon.acceptAt(boundary, frozenPose, activeScopeAdjustment);
});

for (const event of orderedShotEvents) {
  ballistics.advanceTo(event.acceptedAtSeconds);
  ballistics.spawn(composeFrozenShot(event));
}
ballistics.advanceTo(delta);
```

Add an integration test around the adapter/timeline that drives the same moving and rotating player command stream at 30/60/144 Hz and compares every spawned origin, sight/bore/projectile direction, spawn time, and resolved result.

### CR-02 — BLOCKER: Completed telemetry combines unrelated aggregate, terminal, and target-specific results

**File:** `src/fps/ui/CombatTelemetry.ts:154-183`

**Issue:** `publishShot()` selects `result.report` (the last damaged target), but fills the same `ShotTelemetry` with `result.damageApplied` and `result.destroyed` (aggregates across every damaged target), `result.hit?.distance` (the terminal stopping contact), `trace.impact` (also the final impact), and the last surface interaction. A penetrating shot can damage or destroy one target and then hit another target, stop in terrain, or expire. In those cases the HUD can label the last target with total damage from several targets, mark it "down" because an earlier target was destroyed, and display the distance/point/object of a later terrain contact. The spec explicitly permits reports on a result whose terminal `hit` is null, making this a normal ballistic path rather than an exotic invalid state.

**Fix:** Keep aggregate shot outcome separate from a target report. If the UI row represents the last target, source every target-specific field from `report`; retain terminal contact and aggregate totals in separately named fields:

```ts
const report = result.report;
const lastShot: ShotTelemetry = {
  // identity and trajectory summary...
  targetId: report?.targetId ?? null,
  objectName: report?.objectName ?? terminalInteraction?.objectName ?? null,
  damage: report?.damageApplied ?? 0,
  destroyed: report?.destroyed ?? false,
  healthBefore: report?.healthBefore ?? null,
  healthAfter: report?.healthAfter ?? null,
  metres: report?.rangeMetres ?? result.hit?.distance ?? null,
  point: report
    ? [report.point.x, report.point.y, report.point.z]
    : terminalImpact
      ? [terminalImpact.point.x, terminalImpact.point.y, terminalImpact.point.z]
      : null,
  totalDamageApplied: result.damageApplied,
  anyTargetDestroyed: result.destroyed,
  // terminal surface fields remain explicitly terminal
};
```

Add cases for target penetration followed by expiry, target followed by terrain, and two damageable targets where only the first is destroyed.

## Warnings

### WR-01 — WARNING: Multi-weapon shot sequences collide in React keys and hit-marker identity

**File:** `src/components/Hud.tsx:71-75, 83-95`

**Issue:** Each `WeaponSystem` starts its own sequence at 1, but recent-shot rows use only `shot.sequence` as their key. Firing the sniper's first shot and then the Glock's first shot creates duplicate sibling keys, allowing React to reuse the wrong row. The hit marker similarly keys only `shotSequence-interactionIndex`; `ImpactTelemetry` omits the available `sourceId`, so the first damaging contact from another weapon may keep the same key and fail to restart a keyed CSS animation.

**Fix:** Use the full shot identity everywhere and preserve `ImpactEvent.sourceId` in telemetry:

```tsx
<li key={`${shot.sourceId}:${shot.sequence}`}>...</li>

<div
  key={`${combat.lastImpact.sourceId}:${combat.lastImpact.shotSequence}:${combat.lastImpact.interactionIndex}`}
  className="hit-marker"
>
```

Add a HUD/telemetry test with sequence 1 from two different weapon IDs.

### WR-02 — WARNING: The yellow “adjusted bore” debug line actually includes random dispersion

**File:** `src/fps/presentation/ShotTrajectoryDebugView.tsx:54-61, 130-134`

**Issue:** The view names the yellow line `adjusted-bore-segment`, and the FPS spec says it visualizes the turret-adjusted mean bore. It is drawn from `trace.initialDirection`, but the adapter now passes the post-dispersion projectile direction to `BallisticProjectileSystem.spawn()`. Mechanical/handling/bloom dispersion is therefore misreported as scope elevation/windage. The trace contract has no separate mean-bore direction, so this diagnostic cannot verify the five documented aim concepts.

**Fix:** Capture and retain the mean bore separately from the accepted projectile direction:

```ts
ballistics.spawn({
  sightDirection: eventSightDirection,
  boreDirection: eventBoreDirection,
  direction: eventProjectileDirection,
  // ...
});

const boreEnd = start.clone().addScaledVector(trace.boreDirection, INITIAL_AIM_LENGTH);
```

Update the trace test to assert three distinct vectors: sight, mean bore, and dispersed initial projectile direction.

### WR-03 — WARNING: Definition validation accepts values that break cadence and reload state

**File:** `src/fps/weapons/WeaponSystem.ts:127-133, 278-289, 352-408, 432-470`

**Issue:** `validateDefinition()` checks only that RPM compares greater than zero and validates accuracy/recoil fields. It accepts `roundsPerMinute: Infinity`, a zero/non-finite reload duration, invalid ADS durations, fractional/negative magazine counts, and invalid shot range/lifetime/damage. The failures are not benign: an infinite-RPM automatic SAW accepted by the constructor fires the remaining 99 rounds plus dry-fire in one `update(0.001)`, while a zero-duration reload emits `reload-started` but never transfers ammunition or emits completion. Invalid range/lifetime can consume a cartridge and then be rejected later by projectile spawn.

**Fix:** Validate every authored runtime field before assigning state:

```ts
assertFinitePositive(definition.shot.roundsPerMinute, "roundsPerMinute");
assertFinitePositive(definition.shot.range, "range");
assertFinitePositive(definition.shot.maxFlightSeconds, "maxFlightSeconds");
assertFiniteNonNegative(definition.shot.damage, "damage");
assertPositiveInteger(definition.ammo.magazineSize, "magazineSize");
assertNonNegativeInteger(definition.ammo.initialReserve, "initialReserve");
assertFinitePositive(definition.reload.durationSeconds, "reload duration");
assertFiniteNonNegative(definition.ads.enterSeconds, "ADS enter duration");
assertFiniteNonNegative(definition.ads.exitSeconds, "ADS exit duration");
```

Also validate the referenced ammunition or construct weapons only from an already-validated ammunition registry. Extend `tests/fps/weapon-systems.test.ts:102-119` with each boundary above.

### WR-04 — WARNING: A non-finite switch duration permanently wedges the loadout

**File:** `src/fps/weapons/LoadoutSystem.ts:73-100`

**Issue:** `requestEquip()` stores `Math.max(0, durationSeconds)`. For `NaN`, that is `NaN`; every later subtraction remains `NaN`, `switchRemaining === 0` never succeeds, and `switchingTo` permanently blocks weapon commands, ADS, and handling updates. The public method accepts a numeric duration but performs no finite check.

**Fix:** Reject or normalize non-finite durations before mutating switch state:

```ts
if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return false;
this.switchRemaining = durationSeconds;
```

Add tests for `NaN`, both infinities, and negative input, asserting that a failed request leaves the prior switching state untouched.

### WR-05 — WARNING: Default “instance” seeds are identical for every copy of a weapon definition

**File:** `src/fps/weapons/WeaponSystem.ts:75-92, 127-134`

**Issue:** When no seed is supplied, the constructor derives it solely from `definition.id`. Two independently constructed M4 instances therefore have the same seed and emit identical dispersion/recoil-sign sequences. The load test avoids this only by explicitly passing `index + 1`; ordinary `createDevelopmentLoadout()` offers no shooter/instance seed input. Reusing that factory for bots, split-screen, or a replicated harness would make every same-weapon shooter share one pattern, contrary to the stated independent-instance intent.

**Fix:** Make instance identity explicit rather than silently falling back to definition identity. Require an `instanceSeed`, or accept a stable shooter/loadout seed and derive per-slot seeds in `createDevelopmentLoadout()`:

```ts
constructor(definition: WeaponDefinition, instanceSeed: number) {
  if (!Number.isInteger(instanceSeed)) throw new Error("instanceSeed is required");
  this.instanceSeed = instanceSeed >>> 0;
}
```

Add a factory test proving two loadout instances receive different patterns while replaying one stable loadout seed remains deterministic.

### WR-06 — WARNING: GLTF cleanup leaves texture resources and the replaced lens material undisposed

**File:** `src/fps/WeaponPrototype.tsx:85-95, 641-645, 690-701`

**Issue:** `disposeObject()` disposes geometries and materials, but Three.js material disposal does not dispose referenced textures. In addition, assigning `scopeLens.material = lensMaterial` drops the GLTF's original lens material before any cleanup can see it. Unmounting the host, a failed/stale load, or future per-weapon presentation swaps can therefore retain GPU textures and the replaced lens material. This is especially risky for the 27 MB proxy rig and for the new presentation-switching seam.

**Fix:** Dispose the replaced lens material immediately (including textures no longer shared), and make teardown collect unique texture references before disposing materials:

```ts
const disposeMaterial = (material: THREE.Material, textures: Set<THREE.Texture>) => {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) textures.add(value);
  }
  material.dispose();
};

const originalLensMaterial = scopeLens.material;
scopeLens.material = lensMaterial;
disposeOwnedMaterial(originalLensMaterial);

// On teardown, dispose each collected owned texture exactly once after all materials.
```

Track ownership so shared application textures and the preserved custom lens material are not disposed twice.

---

_Reviewed: 2026-08-01T23:14:16Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
