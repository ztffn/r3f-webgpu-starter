# Weapon, ballistics, attachment, and perk evolution roadmap

**Status:** planned technical roadmap

**Baseline:** `f699de2` and
`docs/11-weapon-ballistics-and-modifier-system-spec.md`

**Primary goal:** evolve the current deterministic weapon/projectile slice into
an extensible content system without weakening authority, replay, or load-test
properties

## 1. Why this roadmap exists

The current runtime deliberately stops at one flattened handling-modifier set.
That is enough to prove stance, movement, spread, recoil, bloom, sway, cadence,
and projectile behavior, but it is not enough to author attachments or player
perks safely.

Adding content directly through `WeaponSystem.setHandlingModifiers()` would
leave important questions unanswered:

- Which source wins when a barrel, stock, perk, and temporary status affect the
  same channel?
- Which values are physical ammunition properties versus weapon handling?
- How does a replay or server identify the exact resolved configuration?
- What happens if modifiers change during a burst, cooldown, or reload?
- Which values are frozen into a projectile and which remain live?
- How are invalid or extreme combinations rejected before simulation?
- Can 32–64 weapon instances resolve and fire without per-frame allocation?

This roadmap answers those questions before content volume makes the rules hard
to change. It is deliberately incremental: early phases add pure data contracts
and tests; attachment/perk content comes only after deterministic resolution is
proven.

## 2. Non-negotiable architecture

```text
content registries
  base weapon + ammunition + attachment definitions + perk definitions
    -> deterministic WeaponConfigurationResolver
    -> immutable ResolvedWeaponConfiguration + revision/provenance
    -> WeaponSystem runtime state
    -> accepted ResolvedShotEvent
    -> immutable ResolvedProjectileProfile
    -> BallisticProjectileSystem
    -> authoritative impacts/results

player motor snapshot
  -> stance / grounded / planar speed / breath
  -> live WeaponHandlingContext

React / GLTF / HUD
  <- snapshots and events only
```

The resolver is not an ECS and does not run every frame. It is a pure function
called when loadout content or a modifier source actually changes. The weapon
runtime never queries inventory, player progression, DOM input, physics bodies,
or presentation objects.

The current projectile system remains independent of Rapier. Third-person
controller work may replace the transitional movement adapter, but it supplies
the same plain handling context and does not change this roadmap.

## 3. Target source and result contracts

The exact names may change during implementation, but the separation and
information content are required.

### 3.1 Stable content identity

```ts
type ContentId = string;
type ContentVersion = number;

interface ContentIdentity {
  readonly id: ContentId;
  readonly version: ContentVersion;
}
```

IDs identify authored content; versions identify balance/schema revisions.
Display names and asset paths are not identity. A presentation ID may accompany
a weapon/attachment for rendering, but it never participates in gameplay
resolution unless converted into an explicit gameplay source first.

### 3.2 Typed modifier operations

Avoid a string-keyed stat bag. Use fields whose units and stacking rules are
visible to TypeScript and reviewers:

```ts
interface ScalarModifier {
  readonly add?: number;
  readonly multiply?: number;
}

interface HandlingModifierChannels {
  readonly mechanicalDispersionRadians?: ScalarModifier;
  readonly hipDispersionRadians?: ScalarModifier;
  readonly movementDispersionRadians?: ScalarModifier;
  readonly airborneDispersionRadians?: ScalarModifier;
  readonly bloomPerShotRadians?: ScalarModifier;
  readonly bloomRecoveryPerSecond?: ScalarModifier;
  readonly recoilPitchRadians?: ScalarModifier;
  readonly recoilYawRadians?: ScalarModifier;
  readonly recoilRecoveryPerSecond?: ScalarModifier;
  readonly swayFactor?: ScalarModifier;
}

interface LaunchModifierChannels {
  readonly muzzleVelocityMetresPerSecond?: ScalarModifier;
  readonly nominalDamage?: ScalarModifier;
  readonly roundsPerMinute?: ScalarModifier;
  readonly maxDistanceMetres?: ScalarModifier;
  readonly maxFlightSeconds?: ScalarModifier;
}

interface ActionModifierChannels {
  readonly adsEnterSeconds?: ScalarModifier;
  readonly adsExitSeconds?: ScalarModifier;
  readonly reloadSeconds?: ScalarModifier;
  readonly magazineCapacity?: ScalarModifier;
  readonly reserveCapacity?: ScalarModifier;
}
```

This is a proposed shape, not an implemented API. Some channels may permit only
multiply or only add after balance review. The final schema must encode those
restrictions rather than accepting meaningless operations.

### 3.3 Modifier source

```ts
type ModifierSourceKind = "attachment" | "perk" | "status" | "ruleset";

interface WeaponModifierSource {
  readonly identity: ContentIdentity;
  readonly kind: ModifierSourceKind;
  readonly orderKey: string;
  readonly compatibleWeaponTags?: readonly string[];
  readonly handling?: HandlingModifierChannels;
  readonly launch?: LaunchModifierChannels;
  readonly action?: ActionModifierChannels;
}
```

`orderKey` must come from a canonical policy, not insertion order. Attachment
sources use authored slot order; perks and statuses use stable IDs within their
category. Compatibility is validated before numeric resolution.

### 3.4 Resolved output

```ts
interface ResolvedProjectileProfile {
  readonly revision: string;
  readonly ammunitionId: string;
  readonly projectileMassKilograms: number;
  readonly muzzleVelocityMetresPerSecond: number;
  readonly ballisticCoefficientG1: number;
  readonly penetrationMultiplier: number;
}

interface ResolvedWeaponConfiguration {
  readonly schemaVersion: number;
  readonly revision: string;
  readonly baseWeaponId: string;
  readonly ammunitionId: string;
  readonly sourceIdentities: readonly ContentIdentity[];
  readonly definition: WeaponDefinition;
  readonly handling: WeaponHandlingModifiers;
  readonly projectile: ResolvedProjectileProfile;
}
```

The resolved configuration contains no maps, callbacks, Three.js objects, or
class instances. Freeze it in development builds. The projectile profile
duplicates the numeric launch values an in-flight round needs so later loadout
changes cannot alter it through a shared object reference.

## 4. Resolution algorithm

### 4.1 Canonical stages

```text
1. look up and validate base weapon
2. select compatible ammunition
3. gather compatible modifier sources
4. sort by category and canonical order key
5. fold additive and multiplicative operations per typed channel
6. apply channel-specific rounding and clamp policy
7. validate cross-field invariants
8. build immutable resolved definition/projectile profile
9. build canonical revision and provenance list
```

For a channel that permits both operations, use one documented equation:

```text
resolved = clamp((base + sum(additions)) * product(multipliers))
```

All additions use the channel's native unit. A dispersion addition is radians;
a reload addition is seconds. Never mix percentage literals with multipliers.
Content authoring tools may display “-10%”, but stored gameplay data is `0.9`.

Integer channels require an explicit rule after scalar resolution. Recommended:
round magazine/reserve capacity to the nearest integer, then clamp to the
channel envelope. Do not rely on JavaScript coercion.

### 4.2 Overrides and structural changes

Scalar folding must not decide structural changes such as:

- ammunition replacement;
- supported fire-mode replacement;
- burst-size replacement;
- magazine type or reload procedure;
- projectile behavior family.

Each structural channel needs a named resolver policy. The first attachment
slice should avoid structural overrides entirely. Add them only with dedicated
compatibility and conflict tests.

### 4.3 Validation

Create a pure `validateResolvedWeaponConfiguration()` boundary. It must reject
or report:

- missing/duplicate source identities;
- incompatible weapon/ammunition/attachment tags;
- non-finite operations;
- zero or negative physical/cadence/lifetime values;
- burst mode without a valid burst size;
- recoil/bloom caps below one resolved impulse;
- magazine/reserve values outside integer bounds;
- a resolved configuration that violates per-channel authored envelopes.

Do not silently turn every invalid value into zero. Current runtime sanitation
is a last safety net; content resolution should fail loudly with source and
channel identity so bad data can be fixed.

### 4.4 Revision identity

Build a canonical revision string from:

- resolver schema version;
- base weapon identity/version;
- ammunition identity/version;
- ordered modifier source identities/versions;
- ruleset/balance version.

The canonical string is correctness identity. A compact hash may accompany it
for lookup and network efficiency, but a collision-prone 32-bit hash must not be
the only authoritative identity.

## 5. Runtime application policy

### 5.1 Stable loadout sources

Attachments and ordinary perks should resolve at loadout construction, spawn,
or an explicit equipment transaction. The simplest safe first implementation
creates `WeaponSystem` from a resolved immutable definition before play.

Do not support mid-magazine attachment editing in the first slice. It creates
state-migration questions without helping combat validation.

### 5.2 Live status sources

Suppression, injury, stamina, support/bipod state, or temporary buffs may change
during play. They should form a separate live source layer with a revision that
updates only when the status changes, not each frame.

Applying a live resolved handling set must preserve:

- magazine and reserve;
- cooldown;
- reload timer and transfer semantics;
- trigger and burst progress unless the status explicitly cancels them;
- shot sequence and seed;
- existing recoil/bloom state, clamped only if a changed cap requires it.

The command that changes a gameplay modifier must have an explicit simulation
ordering relative to a trigger edge. A source change before shot acceptance
affects that shot; one after acceptance does not.

### 5.3 Projectile freeze

Accepted shot events should eventually carry `resolvedRevision` plus an
immutable `ResolvedProjectileProfile`. `BallisticProjectileSystem.spawn()` then
copies those numeric values into its shot boundary. Re-equipping ammunition,
removing a barrel, losing a perk, or changing rules cannot affect live slots.

## 6. Phased delivery

### Expected file-level seams

| Area | Expected change |
| --- | --- |
| `weapons/WeaponModifier.ts` | New serializable source/channel types, identities, and validation diagnostics |
| `weapons/WeaponConfigurationResolver.ts` | New pure canonical sort/fold/validate/revision pipeline |
| `weapons/ResolvedWeaponConfiguration.ts` | New immutable resolved weapon and projectile profile contracts |
| `weapons/WeaponDefinition.ts` | Keep authored base values; add tags/envelopes only when a real compatibility rule needs them |
| `weapons/weaponDefinitions.ts` | Register versioned base weapon content; never add presentation paths |
| `weapons/AmmunitionDefinition.ts` | Add stable identity/version and pure validation without making ammunition mutable |
| `weapons/WeaponSystem.ts` | Consume resolved values/revisions while preserving mutable firing state and exact cadence behavior |
| `weapons/LoadoutSystem.ts` | Own equipped build selection and apply explicit configuration transactions |
| `combat/BallisticProjectileSystem.ts` | Copy the resolved launch profile into accepted live slots; remain unaware of attachment/perk sources |
| `core/ScopeAdjustmentController.ts` | Rebuild presets from the same resolved velocity/BC used by live rounds |
| `tests/fps/weapon-systems.test.ts` | Resolver, state-migration, replay-cadence, and 32-system modifier coverage |
| `tests/fps/ballistics.test.ts` | Frozen-profile, mixed-profile, zeroing, penetration, and contact-load coverage |

The names above are proposed module boundaries, not permission to create one
abstraction per table row. If two contracts remain clearer in one small module,
keep them together. The ownership split is the requirement.

### API migration sequence

Keep every intermediate commit runnable:

```text
existing WeaponDefinition
  -> identity resolver produces an equivalent ResolvedWeaponConfiguration
  -> WeaponSystem accepts resolved configuration through a compatibility factory
  -> snapshot/event gains resolvedRevision
  -> accepted shot gains a copied ResolvedProjectileProfile
  -> direct definition construction is removed from production call sites
  -> attachment/perk registries begin producing non-identity sources
```

During the first migration, retain a helper that resolves a bare current
definition with no modifier sources. This prevents presentation and loadout
changes from landing in the same commit as resolver math. Remove or narrow that
helper only after all production construction sites use stable content IDs.

Phase dependencies are intentionally linear through the authority core:

```text
Phase 0 docs
  -> Phase 1 identity + immutable projectile data
  -> Phase 2 handling resolver
  -> Phase 3 attachments
  -> Phase 4 perks/statuses
  -> Phase 5 launch/action channels
  -> Phase 6 replay/network envelope
  -> Phase 7 content scale and rendered benchmark
```

Controller work may proceed beside Phases 1–2 because it only publishes
`WeaponHandlingContext`. It becomes a balance dependency before Phase 3 content
is tuned.

### Phase 0 — documentation and invariant lock

**Deliverables**

- canonical as-built spec;
- this roadmap;
- links from the FPS implementation spec, README, and project orientation;
- explicit list of current modifier limitations and future freeze points.

**Exit gate**

- every numeric budget/formula is verified against code;
- “as built” and planned behavior are visually distinct;
- a new contributor can locate the shot lifecycle and modifier plan from
  `CLAUDE.md`.

### Phase 1 — definition validation and immutable resolved profiles

**Implementation**

- introduce content identity/version types;
- extract full pure validation for weapon, ammunition, and projectile profiles;
- introduce `ResolvedProjectileProfile` while preserving current behavior;
- make projectile spawn defensively copy immutable numeric launch inputs while
  accepted events still use the compatibility path;
- add schema fixtures for all four current weapons and ammunition profiles.

**Tests**

- invalid values report exact source/channel;
- shared definitions cannot be mutated through one weapon instance;
- accepted shots retain launch values after source objects are changed in a
  hostile test;
- existing 30/60/144 Hz and load metrics remain identical.

**Exit gate**

No attachment or perk content yet. The current definitions resolve through an
identity path with byte-for-byte-equivalent gameplay numbers.

### Phase 2 — deterministic handling resolver

**Implementation**

- add typed handling modifier sources and pure resolver;
- encode source category/order policy;
- resolve current all-ones behavior through the new path;
- replace ad hoc callers of `setHandlingModifiers` with one resolved-result
  application method;
- expose resolved revision/provenance in weapon snapshot diagnostics.

**Tests**

- identity, add, multiply, ordering, conflict, clamp, and immutability cases;
- synthetic stock/barrel/perk fixtures combining on the same channel;
- no cooldown, ammo, recoil, or bloom reset on application;
- deterministic results across shuffled input enumeration after canonical sort;
- 32 complete loadouts with heterogeneous modifier sets.

**Exit gate**

Handling modifiers are safe to author, but launch/ammunition/capacity changes
remain rejected.

### Phase 3 — attachment slots and first content slice

**Implementation**

- define a small attachment registry and explicit slots, initially optic,
  muzzle, barrel, underbarrel, magazine, stock, and grip only if required by
  actual content;
- add weapon compatibility tags and mutually exclusive constraints;
- add loadout selection/persistence as plain data;
- map optional presentation IDs separately from gameplay sources;
- start with two or three handling-only fixtures before adding broad content.

**Tests and human acceptance**

- invalid slot/weapon combinations fail before runtime;
- swapping presentation only leaves gameplay revision unchanged;
- a recoil-focused and an accuracy-focused build visibly differ in crosshair,
  burst climb, and recovery while identical builds replay identically;
- proxy assets remain valid; authored models are not a prerequisite.

**Exit gate**

Attachments can alter documented handling channels end to end without changing
projectile physics or weakening load tests.

### Phase 4 — player perks and live status layer

**Implementation**

- define perk content as stable modifier sources owned by player/loadout state;
- resolve ordinary perks at spawn/loadout revision;
- define a separate runtime-status source set for injury, suppression, stamina,
  support, or buffs only when those mechanics exist;
- add an ordered command/event for live modifier revision changes;
- expose revision changes to HUD/debug tooling without making UI authoritative.

**Tests**

- two players with different perks do not share mutable state;
- source addition/removal occurs at the documented simulation boundary;
- held automatic fire uses the new revision only for later cadence boundaries;
- replay with modifier-revision events reproduces accepted offsets;
- status churn does not allocate or resolve every frame.

**Exit gate**

Perks and statuses use the same resolver rules as attachments, with explicit
lifecycle and replay semantics.

### Phase 5 — launch, ammunition, and action modifiers

**Implementation**

- add typed launch/action channels one group at a time;
- make alternate ammunition selection explicit and versioned;
- move the complete resolved projectile profile into accepted shot events and
  copy it into projectile slots, replacing the Phase 1 compatibility path;
- update scope-zero controllers when resolved muzzle velocity/BC changes;
- define magazine-capacity migration and reload policy before enabling magazine
  attachments;
- add structural override policies only for real content needs.

**Tests**

- barrel velocity changes affect both live ballistics and zero presets;
- ammunition mass/BC/penetration changes affect the correct stages only;
- in-flight rounds retain old profiles across a loadout revision;
- capacity changes cannot create or delete ammunition accidentally;
- cadence changes preserve cooldown fraction or follow another explicitly
  chosen migration rule;
- 32-player projectile/contact loads cover mixed resolved profiles.

**Exit gate**

Launch and action content is deterministic, validated, frozen per shot, and
covered by zeroing/penetration/load tests.

### Phase 6 — complete snapshots, replay, and network envelope

**Implementation**

- define serializable weapon runtime snapshots, including resolved revision;
- wrap commands with player, weapon instance, sequence, and simulation tick;
- record modifier-revision events in command/replay streams;
- convert Three.js vectors at the network boundary to explicit numeric tuples;
- build restore-and-replay tests before transport;
- define replicated accepted-shot and impact presentation payloads.

**Tests**

- snapshot/restore at ready, cooldown, burst, reload, empty, and ADS states;
- restore seed/sequence without repeating or changing samples;
- restore during modifier transition and resume exact outcomes;
- predicted local and authoritative replay converge for covered timelines;
- remote presentation never mutates damage or projectile authority.

**Exit gate**

Transport can be added without redesigning command, modifier, or projectile
meaning.

### Phase 7 — content scale, balance tooling, and shipping performance

**Implementation**

- data audit tool that resolves every legal weapon/loadout combination;
- generated balance tables showing final values and provenance;
- representative 32/64-player mixed-loadout browser benchmark with character
  animation, presentation tracers, audio, and target hardware reporting;
- telemetry for revision distribution, rejected content, pool pressure, queue
  overflow, and resolver churn;
- tuning workflow that records source/reference versus deliberate game balance.

**Exit gate**

No invalid combination enters a match, full-match performance is measured on
named hardware, and designers can explain why a final stat has its value.

## 7. Parallel and deferred ballistic work

The following improvements are independent tracks. They must not be smuggled
into attachment/perk implementation unless a real content requirement depends
on them:

- piecewise standard G1 drag calibration;
- projectile radius or more complex swept shapes;
- ricochet/deflection;
- layered armor, spall, fragmentation, and material damage;
- anatomy/limb damage and armor coverage;
- suppression and near-miss events;
- subsonic/supersonic audio and remote tracer policy.

Each changes a different contract and needs its own design and acceptance data.
The current fixed-step pool, world-query seam, and event boundaries are intended
to let these evolve without moving weapon acceptance into the projectile loop.

## 8. Performance rules through all phases

- Resolution occurs on content change, never per render frame or per projectile
  tick.
- Resolved configurations are immutable and shareable between identical
  loadouts where runtime state is not included.
- Weapon instances retain scalar runtime fields; they do not retain a history
  of modifier sources or accepted shots.
- Projectile hot state remains structure-of-arrays. Do not add one object or
  rigid body per live bullet.
- Event consumers drain each update. Any new hard queue defines overflow metrics
  and a deterministic drop policy.
- Debug provenance may allocate outside the hot path and must remain opt-in for
  large loads.
- Every phase re-runs 600/900 RPM at 30/60/144 Hz and reports CPU time without a
  machine-specific pass threshold.

## 9. Migration hazards and chosen responses

| Hazard | Response |
| --- | --- |
| modifier application resets recoil/cooldown | migrate only resolved inputs; preserve runtime fields and test them explicitly |
| shared definition mutation changes other players | immutable resolved output plus hostile mutation tests |
| attachment order changes result | canonical slot/category order before folding |
| percentage and unit confusion | native-unit additions and explicit decimal multipliers |
| capacity reduction deletes ammo | define magazine migration before enabling capacity content |
| velocity modifier desynchronizes scope zero | rebuild scope profile from same resolved projectile data |
| current shot receives its own new recoil | preserve pre-impulse event capture order |
| live round changes after loadout edit | freeze resolved projectile profile at accepted-shot/spawn boundary |
| revision hash collision | canonical revision string is identity; compact hash is optimization only |
| UI or GLTF becomes content authority | gameplay source registry and separate presentation mapping |
| “deterministic” overclaimed across platforms | state supported replay scope and test target runtimes explicitly |
| combinatorial balance explosion | legal-combination audit and generated provenance tables before content scale |

## 10. Dependency relationship with player/controller work

The planned third-person/Rapier/ecctrl controller can proceed after this
documentation milestone. It must publish the existing plain motor data:

```ts
interface WeaponHandlingContext {
  stance: "stand" | "crouch" | "prone";
  grounded: boolean;
  planarSpeedMetresPerSecond: number;
  breathStabilization: number;
}
```

The controller does not resolve attachments or perks. Player progression/loadout
state supplies stable modifier sources to the resolver, while the motor supplies
live movement context. Third-person animation consumes weapon snapshots/events
and the `CharacterAimRig`; it cannot feed bones back into accepted aim.

Phase 1 and 2 of this roadmap may run before or alongside the controller spike.
Phase 3+ content should wait until the controller provides authoritative stance
and speed, otherwise attachment balance will be tuned against the transitional
camera-motion estimate.

## 11. Completion criteria

The roadmap is complete when:

- every equipped weapon has an immutable resolved configuration and stable
  revision/provenance;
- attachments, perks, and statuses share one deterministic typed resolver;
- structural changes use named policies rather than accidental precedence;
- accepted shots freeze all launch data needed by in-flight projectiles;
- weapon/projectile snapshots and command envelopes reproduce covered timelines;
- full 32/64-player mixed-loadout tests remain bounded and are measured with
  complete character/presentation cost;
- content authors can inspect how every final value was derived;
- presentation remains replaceable without changing gameplay revision.

This roadmap intentionally ends at a reliable extensible combat substrate. It
does not require a final attachment UI, a final perk catalog, or final weapon
balance to validate the architecture.

## 12. Next executable slice: Phase 1 task plan

Use this order for the first implementation session. Each task should leave the
existing runtime and all tests green.

### Task 1 — lock identity behavior in tests

Extend `tests/fps/weapon-systems.test.ts` with fixtures that assert:

- every current weapon/ammunition pair produces a stable non-empty revision;
- resolving the same frozen input twice produces deeply equal plain data;
- resolving does not mutate `WeaponDefinition` or `AmmunitionDefinition`;
- duplicate/missing IDs and non-finite physical values report the exact field;
- an identity resolution preserves every currently authored number.

Do not change runtime construction in this task. Its purpose is to make the
migration target executable before introducing it.

### Task 2 — add identity and resolved-profile contracts

Create the smallest modules needed for `ContentIdentity`, validation results,
`ResolvedProjectileProfile`, and `ResolvedWeaponConfiguration`. Start with a
pure base-only entry point such as:

```ts
resolveBaseWeaponConfiguration(
  definition: WeaponDefinition,
  resolverSchemaVersion: number
): ResolvedWeaponConfiguration
```

The result must copy readonly arrays and the ammunition launch values it owns.
Development tests should freeze the returned graph. Production correctness
must not depend solely on `Object.freeze`, because frozen objects are still a
presentation/debug convenience rather than a wire format.

Build the canonical revision from explicit ordered fields. Do not hash
`JSON.stringify()` output whose property order could later change accidentally.

### Task 3 — introduce the compatibility construction path

Add one factory at the loadout/content boundary that resolves a current base
definition and constructs `WeaponSystem`. Convert production loadout creation
and tests incrementally. The weapon instance should retain:

- immutable resolved configuration identity;
- mutable magazine, reserve, mode, trigger, burst, reload, ADS, recoil, bloom,
  cooldown, seed, and sequence fields exactly as today.

Expose `resolvedRevision` in `WeaponSnapshot`. Do not add attachment APIs yet,
and do not re-resolve during `update()`.

### Task 4 — harden the projectile freeze boundary

Add the resolved projectile profile to the accepted-shot/spawn compatibility
path without changing trajectories. At projectile spawn:

- copy hot numeric mass, muzzle velocity, BC, penetration, and muzzle-energy
  inputs into per-slot storage or another immutable shot-local representation;
- keep content identity/revision metadata for completed results and debugging;
- never retain a mutable shared ammunition object as the only source of live
  projectile physics;
- recycle all new per-slot state with the existing pool slot.

Add a hostile-mutation test: spawn a round, mutate the original fixture after
spawn, advance to impact, and require the original trajectory, penetration, and
damage outcome. Keep `captureTrace: false` in load variants.

### Task 5 — keep scope and live rounds on one profile

Change `ScopeAdjustmentController` construction to consume the same resolved
velocity/BC pair used by the projectile spawn path. Preserve existing .308,
5.56, and 9 mm reachable-zero expectations. There must still be only one
velocity integrator.

### Task 6 — verification and atomic delivery

Run:

```sh
npm test
npm run typecheck
npm run build
```

Then compare the 30/60/144 Hz weapon outcomes and the 16/32-player ballistic
metrics with the documented baseline. Report elapsed CPU values, but fail only
on exact gameplay/event regressions or violated bounds.

Suggested atomic commits:

1. tests and pure resolved-profile contracts;
2. identity construction and snapshot revision integration;
3. projectile freeze and scope-profile integration;
4. documentation updates if implementation names or constraints changed.

Phase 1 is finished only when direct shared-definition mutation can no longer
retune an accepted or in-flight shot, current gameplay values remain unchanged,
and the full gate is green.
