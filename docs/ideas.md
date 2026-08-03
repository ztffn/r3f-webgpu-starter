# Character Aim/Look Rig — Implementation Brief (v2)

Revision of v1 following technical review. Changes are substantive; treat this document as authoritative and v1 as superseded.

---

## 1. Objective

Three.js multiplayer shooter. Existing: GLB character, multiple `AnimationClip`s driven by `AnimationMixer`. Add a procedural post-mixer rig that rotates spine/chest/neck/head toward look and aim directions, so players can read when another player is looking at or aiming at them.

The core rig and presentation adapter are implemented and unit tested. They are
not yet mounted on a live third-person character or local-bot harness. They are
architected so that adding bot- or network-driven input is a data-plumbing
change with zero edits inside the rig.

**In scope:** procedural look/aim offsets, channel blending, weight gating, debug harness, benchmark.

**Out of scope, but designed for:** CCDIK, foot IK, weapon hand-grip correction, authored additive clips, root turn-in-place, any networking code.

---

## 2. Frame lifecycle (mandatory)

Running the rig after `mixer.update()` is necessary but **not sufficient**. `AnimationMixer` only writes bones that an active clip actually keys. If a clip has no head track — common in reload, hit-reaction, or hand-authored clips — the mixer leaves the bone holding last frame's procedurally-offset quaternion, and the rig then applies a fresh offset on top of its own previous output. The result is unbounded drift that looks like a damping bug and will not reproduce on the clips you tested with.

Required order, every frame, per character:

```js
aimRig.beginFrame();   // restore each rigged bone to its last known pure animated pose
mixer.update(dt);      // mixer overwrites tracked bones; untracked bones keep the restored pose
aimRig.update(dt);     // capture animated pose, then apply offsets exactly once
```

`beginFrame()` writes each rigged bone's cached `animatedQuat` back into `bone.quaternion`. On the first frame, `animatedQuat` is seeded from the bind pose. This is correct whether the bone is fully keyed, partially keyed during a crossfade, or not keyed at all.

This must survive future imported assets, so it is a structural requirement, not a tuning detail.

---

## 3. Rotation composition (mandatory)

### 3.1 Damp the offset, never the composed pose

The rig maintains a **procedural offset quaternion per bone**, damps that, and composes it with the animated pose:

```js
currentOffset.slerp(targetOffset, alpha);
bone.quaternion.copy(currentOffset).multiply(animatedQuat);
```

It must **not** slerp `bone.quaternion` toward an aimed pose. Doing so low-passes the locomotion animation itself and produces mushy spine motion during running and crossfades.

### 3.2 Compose in parent space, not bone-local axes

Do not assume local X is pitch and local Y is yaw — that assumption holds for some rigs and silently fails on others, and it makes the multiply-vs-premultiply question a matter of trial and error.

Instead, build the desired delta **once** in character-root space, then convert it into each bone's parent space:

```
qDeltaRoot  = quatFromAxisAngle(rootUp, yaw) * quatFromAxisAngle(rootRight, pitch)
qDeltaWorld = qRootWorld * qDeltaRoot * qRootWorld⁻¹
qOffset_i   = qParentWorld_i⁻¹ * qDeltaWorld * qParentWorld_i
```

Then **pre**-multiply, because the offset is expressed in parent space:

```js
bone.quaternion.copy(qOffset_i).multiply(animatedQuat);
```

Derivation: `world = parentWorld · local`. Wanting `newWorld = qDeltaWorld · parentWorld · local` gives `newLocal = parentWorld⁻¹ · qDeltaWorld · parentWorld · local = qOffset · local`.

This makes the rig axis-agnostic across rigs and removes the need for a `forwardAxis`/`upAxis` profile entry. Document the composition order in code comments regardless.

### 3.3 Traverse root → leaf, propagating world quaternions

`qParentWorld_i` must reflect **this frame's already-applied offsets**, or the head is oriented against a stale chest — which reads as a subtle lag easily mistaken for a damping problem.

Walk the chain strictly root→leaf and propagate manually, quaternions only:

```js
qWorld_i = qParentWorld_i * bone.quaternion   // after applying bone i's offset
```

Do **not** call `updateMatrixWorld()` inside this loop. Three.js will update matrices before render as usual.

### 3.4 Note on damping frame

The damped offset lives in a frame that itself rotates with the body. At normal frame rates this is standard practice and visually correct. It is worth knowing if you later see minor artifacts during very fast root rotation.

---

## 4. Public API (mandatory shape)

### 4.1 Zero-allocation setters

```ts
aimRig.setLook(yaw: number, pitch: number, weight: number): void;
aimRig.setAim(yaw: number, pitch: number, weight: number): void;
```

Primitive arguments only. An object-literal setter — `setTarget({ yaw, pitch, weight })` — allocates once per character per frame at the *caller*, which defeats the rig's own zero-allocation guarantee and is invisible in the rig's source. A reused shared object avoids the allocation but introduces aliasing hazards; primitives avoid both.

The rig must never hold a reference to an `Object3D`, camera, bot, or network entity. Bot AI writes into these setters today; the network presentation adapter writes into the same setters later. The signature does not change.

### 4.2 Channel semantics

| Channel | Drives | Diverges when |
|---|---|---|
| `aim` | spine + chest primarily, head via arbitration | recoil, ADS offset, weapon sway (later) |
| `look` | neck + head primarily | idle head-tracking, checking a flank while weapon stays forward |

**Head arbitration (required).** The head target is not simply the look channel. It blends toward the aim channel as aim weight rises:

```
headTarget = slerp(lookTarget, aimTarget, aimWeight * headAimBias)
```

with `headAimBias` in the profile (start ~0.8). Rationale: when a player is aiming, their head follows the sights — a rig where head and aim never interact reads as a character looking past their own weapon. Without this rule an implementer builds two channels that coexist but never combine correctly.

Weight gating by state: aim weight drops sharply during reload, sprint, roll, and hit reactions; look weight stays partially active. Final per-bone clamps are applied **after** channel composition, never per channel.

### 4.3 Exposed output

```ts
aimRig.residualYaw: number;  // desired yaw minus total applied yaw, radians, root-local
```

A target behind the character otherwise pins against the clamp indefinitely. The rig does not perform turn-in-place in this phase; it publishes the unconsumed rotation so the character controller can later request a root turn. This keeps root turning out of the cosmetic rig while avoiding a future interface retrofit.

---

## 5. Coordinate contract (mandatory)

Underspecified angles are the most likely source of silent breakage once networking lands. State all of this in code and README:

- Angles are **radians**, in **character-render-root local space**.
- Zero yaw points along the authored character-forward axis; document whether that is `+Z` or `−Z` for your GLB.
- Handedness of positive yaw is documented explicitly. Positive pitch looks **upward**.
- Yaw is normalized to `[−π, π]` **before** clamping and before building the target quaternion.
- Root roll / slope alignment: state whether it affects the aim frame (recommended: it does not — aim frame uses world up, not root up, so aiming stays level on slopes).

### 5.1 Two named data forms

```ts
AuthoritativeAimState   // world-oriented direction. Gameplay truth. Never damped, never clamped.
AimRigRenderInput       // root-local yaw/pitch/weight. Cosmetic. Damped and clamped.
```

A **presentation adapter** converts the former into the latter. The rig never becomes aware of networking or remote transforms.

Keep network state **world-oriented**. Consequence: when the root rotates while world aim is stationary, root-local yaw changes automatically and the rig corrects without any target change — which is the correct behaviour and is covered by test case 9.3.

Distinct type names make it materially harder to accidentally feed smoothed presentation state into gameplay code. Hit detection, "you are being targeted" indicators, and any scoring logic read `AuthoritativeAimState` only.

---

## 6. Rig profile

Per-skeleton initialization object. Bone lookup and scene traversal happen **here only**, never per frame.

```ts
interface AimRigProfile {
  bones: { spine: string; chest: string; neck?: string; head: string };
  yawWeights:   BoneWeights;   // e.g. spine .20  chest .30  neck .15  head .35
  pitchWeights: BoneWeights;   // deliberately different from yaw
  limits: Record<BoneName, { yaw: [min, max]; pitch: [min, max] }>;
  headAimBias: number;         // §4.2
  damping: { lookHalfLife: number; aimHalfLife: number;
             weightAttackHalfLife: number; weightReleaseHalfLife: number };
}
```

Yaw and pitch require **separate** distributions — a split tuned to look good in yaw generally looks wrong in pitch, where the chest and head should carry proportionally more.

No `forwardAxis`/`upAxis` entries: §3.2 removes the need.

Starting clamps: combined spine+chest ≈ ±40°, head ≈ ±60°. Tune by feel.

---

## 7. Damping

```js
const lambda = Math.LN2 / halfLifeSeconds;
const alpha  = 1 - Math.exp(-lambda * dtClamped);
```

- Half-life is the tuning parameter, not lambda — it is directly interpretable ("offset covers half the remaining gap in 80 ms").
- Applies to each procedural **offset** quaternion (§3.1), never the composed bone quaternion.
- `dtClamped = Math.min(dt, DT_MAX)` with `DT_MAX ≈ 0.1 s`, guarding tab suspension and severe hitches.
- **Separate attack and release half-lives for weight.** Aim needs to vanish fast on a roll or hit reaction but return gradually.
- Normalize yaw before clamping and before constructing the target quaternion.

**Forward-looking constraint:** once netcode lands, remote-player aim arrives already smoothed by entity interpolation. Layering rig damping on top double-smooths and adds perceived latency to precisely the signal players are reading. Remote characters should use near-zero rig damping; local/bot characters use the tuned values. Make half-life per-instance, not a module constant.

---

## 8. Three.js usage

Phase one uses **direct local quaternion composition after `AnimationMixer.update()`**. Required primitives: `AnimationMixer`, `AnimationAction`, `Bone`, `Quaternion.slerp/multiply/premultiply`, `SkeletonHelper` (debug only).

`AnimationUtils.makeClipAdditive` and `AdditiveAnimationBlendMode` are **clip-level** mechanisms and are not required here. They remain available later for authored recoil, breathing, injury, and aim-pose layers.

`CCDIKSolver` / `CCDIKHelper` remain available as three.js addons for a later hand-to-weapon-grip or foot-IK phase. Not used now.

**Noted fallback:** purely procedural spine bending can read as rubbery on some rigs, because real torsos do not rotate uniformly along the chain. If visual quality disappoints after tuning §6, the alternative is blending a small set of authored aim poses (up/down/left/right) via additive clips. Prototype only if procedural output is unsatisfactory — do not build both.

---

## 9. Debug harness

Smooth sinusoidal targets hide nearly every implementation defect. Provide buttons or automated cases for:

1. Instant target jump across the yaw wrap boundary (±π).
2. Target directly behind the character (exercises `residualYaw`).
3. Root rotation while world aim is stationary.
4. Idle ↔ run crossfade while aiming.
5. **Clip with no head or chest track** — the §2 accumulation test. Run for 60+ seconds and assert offset does not drift.
6. Weight snapping 1 → 0 instantly.
7. Simulated 100–250 ms frame hitch.
8. Yaw and pitch targets differing substantially.
9. Look and aim channels deliberately diverging.

Debug rays, drawn simultaneously:
- raw input direction,
- post-clamp direction,
- final rendered head forward.

These three rays surface coordinate-space and clamp errors far faster than `SkeletonHelper` alone. Keep `SkeletonHelper` as a separate toggle.

Live controls (lil-gui or similar): per-bone yaw/pitch limits, yaw and pitch distributions, half-lives, `headAimBias`, per-channel weight override.

---

## 10. Performance criteria (measurable)

"No discernible frame cost at 10 bots" is unfalsifiable and too small a proxy for a multiplayer scene. Required instead:

- Benchmark mode running **32 and 64** rig updates per frame.
- `SkeletonHelper` and debug rays **disabled** during measurement.
- Rig-update time measured separately from rendering and skinning; report **median and p95** over ≥600 frames.
- **Zero allocations after initialization**, verified in the browser allocation profiler. Stable heap after warm-up.
- Bone lookup and scene traversal permitted **only** at initialization.
- No fixed millisecond budget until target hardware is defined — but the benchmark must emit numbers, not impressions.

**LOD note:** for distant or off-screen characters the rig may be skipped. If skipped, offsets must be driven to identity or explicitly frozen — a half-applied frozen offset pops when the character returns to range. Gameplay is unaffected either way, since hit detection reads `AuthoritativeAimState`, not bones.

---

## 11. Deliverables and current status

1. ✅ **`CharacterAimRig` module** — `beginFrame()`, `setLook()`, `setAim()`,
   `update(dt)`, `residualYaw`; implemented in
   `src/fps/presentation/CharacterAimRig.ts` with drift/clamp unit coverage.
2. ✅ **Presentation adapter** — `AuthoritativeAimState` → `AimRigRenderInput`,
   implemented in `CharacterAimPresentationAdapter.ts`. It is the sole future
   insertion point for bot or network presentation input.
3. ⬜ **Bot/character harness** — N mounted characters with waypoint or scripted
   targets, feeding the rig through setters only.
4. ⬜ **Visual debug harness and browser benchmark** — §9 and §10. Pure rig
   behavior is tested, but 32/64 mounted-character median/p95 and allocation
   profiling have not been performed.
5. ✅ **README/implementation contract** — the coordinate and lifecycle contract
   is recorded in `src/fps/README.md` and `docs/10-fps-combat-implementation-spec.md`.

---

## 12. Acceptance criteria

- **Accumulation:** with a head-track-free clip looping for 60 s at a fixed target, the head offset is bit-stable. No drift.
- **Animation fidelity:** locomotion spine motion during run and crossfade is visually identical with rig weight at 0 and at 1 with a stationary target. Confirms §3.1.
- **Axis independence:** rig produces correct results on a second skeleton with different bone-local axes, changing only `AimRigProfile.bones`.
- **Coordinate contract:** all nine §9 cases pass with debug rays agreeing.
- **Separation:** `AimRig` source contains zero references to `Object3D`, camera, bot, or network types. Grep-verifiable.
- **Gameplay independence:** no gameplay system reads a bone transform. Hit detection and targeting indicators read `AuthoritativeAimState` only.
- **Performance:** 64-character benchmark emits median and p95 rig-update timings; allocation profiler shows a flat heap post-warm-up.
- **Reviewability:** a reviewer can point at the presentation adapter and confirm that replacing bot AI with network deserialization touches zero lines inside `AimRig`.

---

## Appendix A — Reference reading (archival; do not imitate architecture)

Read after implementing, or not at all. None of these ship a spine/head aim rig; the piece is small enough to hand-build against our own skeleton.

- **swift502/Sketchbook** — three.js + cannon.js third-person controller. **Archived by its owner on 10 Oct 2024**; treat as an architectural reference for character state machines and animation blending, not as current three.js guidance. Active forks exist (e.g. `SergioLavao/Sketchbook`).
- **mohsenheydari/three-fps** — entity/component FPS example, root-motion NPCs, basic AI. Early-stage.
- **0x45dgeRunner/threejs-third-person-shooter** — single-file "sketch mode" TPS loop. Scavenge pieces only.
- **jgarrettvml/threejs-multiplayer** — server-authoritative movement sync; useful for message shapes when netcode begins.

**Netcode (required before the networking phase, not before this one):** Gabriel Gambetta, *Fast-Paced Multiplayer* — client-server architecture, client-side prediction and server reconciliation, entity interpolation, lag compensation. The §5.1 split and §7 remote-damping note are designed to slot directly into that model. Yahn Bernier's Source-engine latency-compensation paper is the companion reference once aim direction feeds hit detection.
