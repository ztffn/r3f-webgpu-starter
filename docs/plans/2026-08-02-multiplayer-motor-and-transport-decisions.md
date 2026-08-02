# Multiplayer motor and transport decisions

**Status:** decided. Lays out the motor layer of the multiplayer plan that `01-...md` §2
holds open; the session/transport layer stays deliberately undecided below.

**Date:** 2026-08-02

**Scope:** what gets built now, what stays deferred, and the measurements that resolve the
deferral. This is not a networking implementation plan and contains no transport code.

**Supersedes:** the ecctrl adoption question in
`plans/2026-08-01-ecctrl-player-vehicle-controller-spike-design.md` §"Options and decision
outcomes" — outcome 1 is eliminated below.

## 1. Context

`01-...md` §2 puts multiplayer on hold with two standing instructions: **don't build
networking, prediction or authority models**, and **don't make choices that foreclose them
either**. The target it names is a 64+ player shooter, restated in `05-...md` §3.

This document acts on the second instruction only. Everything decided here is about the
shape of the simulation layer. Nothing here builds transport, matchmaking, or authority.

Three parts of the codebase already have the required shape and are the precedent:
`WeaponSystem` and `LoadoutSystem` take serializable commands and hold no React or Three.js
state; `FiringTimeline` puts an entire frame on one clock with sub-frame acceptance
boundaries; `CompositeWorldQuery` resolves collision against the canonical CPU heightfield
and explicit colliders with no renderer involvement. All three are tested headless under
Node today.

## 2. Decision: no bitwise determinism. Reconcile from snapshots

Rapier's JS/WASM build guarantees cross-platform determinism for the physics step: the same
version with identical initial conditions produces byte-identical world snapshots across
browsers, operating systems and processors. The same guarantee explicitly excludes
transcendental functions — `Math.sin` and `Math.cos` are named as not cross-platform
deterministic.

Our gameplay layer is built on exactly those. `AimSwayController` derives sway from
`Math.sin`/`Math.cos` of an accumulating phase; recoil and bloom decay through `Math.exp`;
dispersion samples `Math.sin`/`Math.cos` of a hashed angle. Eight modules under `src/fps/`
use transcendentals. `11-...md` §7.2 already scopes our determinism claim to "inside the
supported JavaScript runtime, not bit-identical across every implementation" — that
sentence is now load-bearing rather than a caveat.

**Therefore:** the authority model is client prediction with server reconciliation from
authoritative snapshots, where float divergence is absorbed continuously. Lockstep and
rollback are rejected: they require bitwise agreement we cannot supply without purging
transcendentals from the gameplay path, and they are the wrong model for a 64-player
shooter regardless.

Rapier's determinism remains valuable — it shrinks correction magnitude and makes
divergence a measurable quantity rather than noise — but no part of the design may depend
on it holding.

## 3. Decision: build the shared headless character motor now

One motor implementation runs in both places: the browser for prediction, Node for
authority. It is plain TypeScript over Rapier WASM.

```text
sequenced PlayerCommand (tick, input bits, look angles)
  -> fixed-tick motor step against Rapier + the CPU heightfield
  -> MotorState (position, velocity, yaw, stance, grounded, contact flags)
  -> [client] presentation: camera, character model, HUD
  -> [server] authority: snapshot, visibility, damage
```

Binding rules, all of which the existing FPS layer already satisfies:

- the motor reads no DOM, no `KeyboardEvent`, no GLTF bone, no camera;
- commands and state are plain serializable data carrying tick identifiers;
- the motor never allocates per step in the hot path;
- it must be constructible and steppable in a Node test with no browser globals.

This is the "don't foreclose it" clause discharged. It is buildable today, it improves the
single-player game on its own, and it is the only artifact that makes the deferred
measurements in §7 possible.

## 4. Decision: ecctrl is not the authoritative implementation

The spike's outcome 1 — adopt ecctrl behind project-owned adapters — is eliminated before
the spike runs. Ecctrl is a React component built around `useFrame` and a mounted rigid
body. Running it as server authority means forking or reimplementing it, and the spike's
own multiplayer gates already state that an integration which only works as an opaque
React render-loop component fails the authoritative-motor gate.

The spike narrows to outcomes 2 and 3: read ecctrl, harvest its slope, step, floating-body
and stability techniques where the licence permits, and build our own motor. Record what
was harvested and what was written from scratch, so the adoption question has a real
answer rather than an assumption.

## 5. Decision: transport behind an interface, first test on bare WebSocket

The motor is expected to work within days, and a real two-client session test follows
immediately. That test does not need a session framework.

- **Now:** a transport interface with two methods in each direction — send command batch,
  receive snapshot — and one implementation over `ws` with hand-rolled binary packets. Tens
  of lines. Its purpose is to produce the §7 measurements, and it is explicitly disposable.
- **Provisional:** Colyseus with the official `@colyseus/uwebsockets-transport` for rooms,
  matchmaking, reconnection and lifecycle, with the hot path on raw binary messages and
  Schema restricted to lobby and match metadata. Adopt on evidence from §7, not before.
- **Rejected for now:** geckos.io. It is maintained and its WebRTC data channels are
  genuinely UDP, but WebTransport reached Baseline across Chrome, Edge, Firefox and Safari
  26.4 in March 2026, which delivers unreliable datagrams without the ICE/STUN/TURN
  operational tax. Revisit only if WebTransport's installed base proves insufficient.
- **Not chosen, deliberately:** WebTransport as the first transport. It is available, but
  Baseline is recent and a WebSocket path is needed for installed-base lag anyway. The
  interface exists so this is a swap, not a migration.

Colyseus scales by distributing rooms across processes. Our problem is one dense room. No
public benchmark resembling a 64-player FPS room was found; community reports range from
16 players per room to a few hundred across all rooms. **This is the single unvalidated
assumption in the stack and it is why the framework choice is deferred rather than made.**

## 6. Decision: two collision representations, with a stated tolerance

Character collision will be Rapier. Bullets stay on `CompositeWorldQuery` — the analytic
heightfield plus registered simplified colliders — as `10-...md` §4 and `11-...md` §11
require. Rifle rounds do not become Rapier bodies.

That means two representations of the same world, and they can disagree: a round may pass
through a gap a body cannot enter, or the reverse. This is accepted, not overlooked. The
spike must measure the disagreement on the test course and record a tolerance. A player
being shot through cover they are standing behind is the failure this bounds.

## 7. Open measurements

These decide the deferred questions. None can be answered by reading.

1. **Cross-runtime divergence.** One recorded command stream through the motor in browser
   and in Node; plot position and velocity divergence over several thousand ticks. Sets the
   snapshot rate and correction strategy.
2. **Dense-room cost.** 64 motors in one room, fixed-tick, measuring server CPU per tick,
   snapshot bytes per client per second, and behaviour as tick and patch rates diverge.
   Decides Colyseus versus a custom room loop.
3. **Correction rate and magnitude** under representative latency and loss, and whether
   corrections are perceptible on the local weapon and camera.
4. **Motor cost at scale** on the client: 64 remote entities consuming interpolated
   snapshots without running input or camera.
5. **Collision-representation disagreement** between the Rapier character world and
   `WorldQuery`, per §6.

## 8. What this does not decide

Matchmaking, persistence, accounts, anti-cheat, server deployment topology, vehicle classes
beyond one primitive wheeled test body, the `packages/` monorepo restructure in `05-...md`
§7, and any animation or third-person presentation work. The monorepo move in particular is
its own phase: `10-...md` §9.1 documents that the import and test-flag setup is fragile.

## 9. Rejected alternatives

| Rejected | Why |
| --- | --- |
| Lockstep / rollback determinism | Requires bitwise agreement; our gameplay path uses transcendentals Rapier explicitly excludes. Wrong model at 64 players. |
| Ecctrl as authoritative movement | React render-loop shaped; cannot run headless as server authority without a fork. |
| Colyseus Schema for the simulation hot path | Schema is a general state-sync tool; a fixed-tick shooter wants hand-packed binary. Schema stays for lobby and match metadata. |
| geckos.io | WebTransport now delivers datagrams Baseline without WebRTC signalling infrastructure. |
| Choosing the session framework now | The measurement that decides it needs 64 motors, which do not exist yet. |
| Rapier rigid bodies for bullets | Already rejected in `10-...md` §10 and `11-...md` §11; unchanged. |
