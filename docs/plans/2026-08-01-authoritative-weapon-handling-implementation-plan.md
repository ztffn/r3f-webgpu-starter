# Authoritative weapon handling implementation plan

## Objective

Implement the approved design in
`2026-08-01-authoritative-weapon-handling-design.md` on top of the current
uncommitted data-driven weapon/fire-mode work. Keep every change inside
`src/fps/**`, `tests/fps/**`, the narrow FPS addition to
`src/components/Hud.tsx`, and the related documentation. Do not add weapon
assets or change terrain, grass, world rendering, ecctrl, Rapier, or networking.

The work is complete only when weapon definitions, simulation, projectile
direction, presentation feedback, and the 32-system load test all describe the
same recoil/spread state.

## Checkpoint 1 — lock contracts and tuning data

**Files**

- Modify `src/fps/weapons/WeaponDefinition.ts`.
- Modify `src/fps/weapons/weaponDefinitions.ts`.
- Add `src/fps/weapons/WeaponHandling.ts` if the shared context, modifier, and
  calculation types would otherwise make `WeaponDefinition.ts` unwieldy.
- Extend `tests/fps/weapon-systems.test.ts`.

**Changes**

1. Add serializable accuracy and expanded recoil definitions.
2. Add `WeaponHandlingContext` and an all-ones
   `WeaponHandlingModifiers` default. Do not implement attachment slots.
3. Author provisional sniper, M4, Glock, and SAW values with explicit radians
   and recovery units.
4. Extend constructor validation for finite non-negative dispersion/bloom,
   positive recovery, and positive caps that can contain a single impulse.
5. Add definition tests that fail malformed handling data and assert the four
   weapons expose independent gameplay tuning with no presentation fields.

**Checkpoint verification**

```sh
npm test -- --test-name-pattern="weapon definitions|handling definition"
npm run typecheck
```

## Checkpoint 2 — implement deterministic weapon state

**Files**

- Modify `src/fps/weapons/WeaponSystem.ts`.
- Modify `src/fps/weapons/LoadoutSystem.ts`.
- Extend `tests/fps/weapon-systems.test.ts`.

**Changes**

1. Give `WeaponSystem` scalar recoil pitch/yaw, bloom, handling context,
   modifier state, and a normalized 32-bit instance seed.
2. Add allocation-free seed hashing and uniform-disk dispersion sampling keyed
   only by instance seed and accepted-shot sequence.
3. Set/sanitize handling context before commands can accept an immediate shot.
   Route that context through `LoadoutSystem`, not through GLTF presentation.
4. Refactor cadence advancement so recovery is integrated to each firing
   boundary. At a boundary: calculate the cone, capture pre-impulse recoil and
   the dispersion sample, emit the shot, then add/cap recoil and bloom.
5. Recover state during reload and while unequipped. Preserve state across mode
   changes and equipment switches; retain existing trigger, burst, reload, and
   queue-cancellation semantics.
6. Extend shot events and snapshots with plain numeric handling fields. Do not
   put Three.js vectors or random functions in gameplay events.

**Tests to add before integration**

- same seed/timeline gives the same samples; different seeds diverge;
- first shot captures pre-impulse recoil, second shot sees the first impulse;
- bloom caps and recovers; recoil recovers monotonically;
- stance/movement/grounded/ADS/breath cone ordering;
- mode selection cannot reset recoil, bloom, or cooldown;
- reload and switching cancel bursts without freezing recovery;
- one slow update crosses every 600/900 RPM cadence boundary with distinct
  per-shot state.

**Checkpoint verification**

```sh
npm test -- --test-name-pattern="recoil|dispersion|bloom|cadence"
npm run typecheck
```

## Checkpoint 3 — compose authoritative shot directions

**Files**

- Modify `src/fps/core/PlayerMotor.ts` only if the reusable motor snapshot can
  gain planar speed without requiring changes outside the allowed FPS scope;
  otherwise keep speed in a dedicated handling context.
- Modify `src/fps/core/LocalPlayerController.ts`.
- Modify `src/fps/WeaponPrototype.tsx`.
- Add focused math tests under `tests/fps/` if direction composition is
  extracted into a reusable helper.

**Changes**

1. Extend the local controller snapshot seam with finite planar speed. In the
   transitional camera host, estimate horizontal speed from reused previous
   position and delta state; clamp teleports and hitches.
2. Set handling context before consuming ordered weapon commands.
3. Replace the current presentation-only recoil refs as gameplay truth with
   the weapon snapshot/event offsets. Keep a separate fast cosmetic kick driven
   by the accepted event.
4. Compose base sway, event recoil, scope adjustment, and event dispersion in
   the exact order specified by the design. Reuse vectors/quaternions.
5. Spawn every event with its individually captured direction, including
   multiple auto rounds drained in one render frame. Keep recoil application
   after acceptance.
6. Orient the end-of-frame proxy rig and scope capture with the current mean
   recoil state so they show what will influence the next shot.

**Checkpoint verification**

- Unit-test local angular composition, normalization, and zero-offset identity.
- Manually enable trajectory debug and verify successive M4/SAW rounds do not
  share one final-frame direction.
- Run `npm test` and `npm run typecheck`.

## Checkpoint 4 — add the hipfire crosshair without a React hot path

**Files**

- Add `src/fps/ui/WeaponAimIndicator.ts` for a mutable presentation snapshot.
- Add `src/fps/ui/HipfireCrosshair.tsx`.
- Modify `src/fps/WeaponPrototype.tsx`.
- Modify `src/fps/debug/debugConfig.ts`.
- Modify `src/components/Hud.tsx` only to mount the FPS indicator.

**Changes**

1. Publish mean-sight screen position, cone radius, ADS fade, and visibility
   into a mutable presentation store. This store is never consulted to accept
   a shot.
2. Render a compact four-arm SVG or DOM crosshair. Update element attributes or
   CSS variables from one `requestAnimationFrame` loop and refs; do not call
   React state setters at weapon-frame cadence.
3. Project angular cone radius using the live camera FOV and viewport height.
   Clamp only the visual size, not gameplay accuracy.
4. Expand for handling/bloom, contract during recovery, centre on mean recoil,
   and fade as ADS becomes active.
5. Add a query/debug option that disables the crosshair and ensure teardown
   clears visibility and cancels the animation frame.

**Checkpoint verification**

- Crosshair remains centred and compact when stationary.
- Stand, crouch, prone, movement, and sustained fire visibly change its radius.
- Recoil shifts its centre; recovery returns it smoothly.
- It fades before the proxy optic becomes the primary sight and disappears on
  component teardown.
- React profiling shows no frame-rate `Hud` rerender caused by the indicator.

## Checkpoint 5 — extend cadence and 32-system acceptance

**Files**

- Extend `tests/fps/weapon-systems.test.ts`.
- Add a short weapon-event-to-projectile test under `tests/fps/` only if it can
  reuse the existing ballistics fixtures without duplicating the load test.

**Changes**

1. Run equivalent serialized command and handling timelines at 30, 60, and
   144 Hz for 600 RPM and 900 RPM definitions.
2. Compare accepted event order, sequence, recoil/dispersion offsets, ammo,
   reload events, mode events, final recoil, and final bloom. Use tight numeric
   tolerances only where exponential integration requires them.
3. Exercise 32 complete `LoadoutSystem` instances with distinct deterministic
   seeds. Drain every real event queue each update.
4. Deplete magazines, emit one dry-fire per press, complete at least one reload,
   resume automatic fire, and assert exact counts.
5. Report elapsed CPU time, accepted shots, dry fires, reload starts/completions,
   mode changes, and a checksum of directional offsets. Do not assert a
   machine-specific time threshold.
6. Confirm the test retains no per-shooter shot history after events are
   drained.

**Checkpoint verification**

```sh
npm test
npm run typecheck
npm run build
git diff --check
```

## Checkpoint 6 — align documentation and review boundaries

**Files**

- Update `src/fps/README.md` with controls, handling semantics, crosshair
  meaning, deterministic seed behavior, and human-test steps.
- Update `docs/10-fps-combat-implementation-spec.md` only after implementation
  so its ownership table, frame order, module map, verification count, and
  deferred list remain genuinely as-built.
- Re-read both new planning documents and remove any promise the implementation
  intentionally changed.

**Final review**

1. Confirm `WeaponSystem` owns authoritative recoil/bloom and presentation
   cannot write them.
2. Confirm mechanical dispersion remains separate from stance/movement
   handling error.
3. Confirm commands and events remain serializable and shot sampling depends
   on simulation identity/sequence rather than render cadence.
4. Confirm no Three.js or asset URL entered gameplay definitions.
5. Confirm no per-tick allocation, unbounded event history, Rapier bullet, ECS,
   attachment system, or networking transport was introduced.
6. Inspect `git status` and preserve the existing ecctrl planning commit and all
   previously approved uncommitted weapon work.

Do not commit or push until the user reviews the resulting changes and gives
explicit approval.
