# Character motor and networking — as built

**Read this before touching `src/motor/` or `src/net/`.** It is the as-built record for the
shared character motor and the disposable transport built on top of it, in the same spirit
as `08-...md` for terrain and `10-...md` for combat: module map, contracts, the invariants
that break silently, and the traps that have already been paid for.

Decisions live in `plans/2026-08-02-multiplayer-motor-and-transport-decisions.md`.
Measurements live in `plans/2026-08-02-motor-measurements.md`. This file describes what the
code does.

## 1. What exists

One character motor that runs unchanged in the browser for prediction and in Node for
authority, a room that owns the world step, a transport interface with one WebSocket
implementation behind it, and a two-client session harness.

- Playable in the game with `?scene=motor`.
- Two browser clients share one authoritative room over real sockets.
- 36 headless tests under `tests/motor/`, running in bare Node with no browser globals.

Weapon handling reads the motor: `?scene=scope&motor=1` carries the weapon on a collided
body, and `WeaponHandlingContext` gets stance, planar speed and real grounded state from
`MotorState` instead of inferring them from the camera. That last one is the point — camera
differentiation cannot tell you the player is airborne, so before this `grounded` was
whatever the app's fly/on-foot toggle said and `airborneDispersionRadians` never applied.

What does **not** exist: matchmaking, reconnection, persistence, anti-cheat, vehicles, and
animation. On the weapon side the motor still does not own the shot origin (the camera
does), recoil does not push the body, and movement is not constrained while reloading or
aiming.

## 2. Module map

| Module | Owns | Must not own |
| --- | --- | --- |
| `motor/MotorTypes.ts` | the wire contract: commands, state, tuning, input bits | anything importable only in a browser |
| `motor/CharacterMotor.ts` | one character's fixed-tick simulation over Rapier | the world step, the camera, input |
| `motor/TerrainCollider.ts` | Rapier collision surfaces built from a height source | terrain rendering, LOD, materials |
| `motor/MotorRoom.ts` | many motors, one world, one step per tick | transport, snapshots, sockets |
| `motor/MotorWorld.ts` | Rapier bootstrap and world construction | gameplay |
| `net/Transport.ts` | the four-method transport seam | framing semantics, packet meaning |
| `net/SnapshotCodec.ts` | hand-packed binary and angle quantisation | when to send |
| `net/GameServer.ts` | authority: command intake, tick, broadcast | which socket library is in use |
| `net/GameClient.ts` | prediction, reconciliation, remote interpolation | rendering, input devices |
| `net/LoopbackTransport.ts` | an in-process link with simulated latency and loss | production use |
| `fps/MotorControls.tsx` | DOM input to commands, motor state to camera | any simulation |

## 3. The one rule that keeps this shared

**`src/motor/` and `src/net/` import no Three.js and no React at runtime.** Type-only
imports are fine because they erase. This is what lets a Node server construct and step the
identical code, and `tests/motor/*.test.ts` enforce it by loading these modules in bare
Node — if a runtime Three.js import appears, those files stop loading.

`fps/MotorControls.tsx` is the only adapter, and it is presentation only.

## 4. Tick and frame contract

```text
PlayerCommand (tick, button bits, absolute look angles)
  -> CharacterMotor.step        one fixed tick, never wall-clock
  -> MotorRoom.step             every motor, THEN one world.step()
  -> MotorState (feet position, velocity, yaw, stance, grounded, contact flags)
  -> [client] camera and proxy capsule
  -> [server] snapshot broadcast at the patch rate
```

Fixed tick is 60 Hz. Patch rate defaults to 20 Hz and is deliberately independent, so the
two can be diverged for measurement.

**A motor never steps the world.** A room holds many motors and must step once per tick,
not once per player. Getting this wrong is invisible with one player.

**Look angles are absolute, not deltas,** so a replayed command stream reproduces the same
aim regardless of how many packets were lost.

**Position on the wire is the FEET.** Eye height is presentation, derived from stance via
`eyeHeightFor`, which blends between `previousStance` and `stance`.

## 5. Invariants that break silently

1. **Nothing can be queried before the first `world.step()`.** Rapier builds its query
   acceleration structure during a step, so ray casts, shape intersections and the
   character solver all return nothing on a world that has never stepped. It presents as
   "my collider does not exist". `MotorRoom` steps once in its constructor.
2. **`ColliderDesc.heightfield(nrows, ncols, …)` counts CELLS, not samples.** The heights
   array must hold `(nrows + 1) * (ncols + 1)` entries. Passing sample counts throws
   `unreachable` from the WASM boundary with no useful message.
3. **`computedCollision().normal2` points FROM the character INTO the surface.** A floor
   reports a NEGATIVE Y. Reading it as the surface normal makes every "is this too steep"
   test silently never fire. `applyContactConstraints` negates it once, deliberately.
4. **Never recover horizontal velocity from the solved movement.** See §6.
5. **Quantise a command before predicting with it.** The codec rounds look angles to
   int16; a client that predicts with its raw pointer angles reconciles against a server
   that steered slightly differently, every single tick. `quantiseCommand` exists so this
   cannot be forgotten, and `GameClient.predict` calls it.
6. **Never alias mutable state when measuring a delta across a mutation.** See §6.
7. **The motor's stance is the truth, not the app's.** It refuses a stand-up with no
   headroom, so `MotorControls` follows the motor's stance rather than driving it.
8. **Parameter properties are forbidden.** `--experimental-strip-types` runs in strip-only
   mode and rejects them outright. Already documented in `10-...md` §9.1; it bit again here.

## 6. Traps already paid for

Every one of these was invisible until something was measured or looked at.

**Horizontal velocity recovered from solved movement made all slopes unclimbable.**
Recomputing velocity from what the solver achieved is correct for walls and fatal on
slopes: walking into a rise, the solver redirects the request upward and returns almost no
horizontal motion, so velocity collapsed to zero, the next tick requested nearly nothing,
and the character was pinned after one tick of acceleration. Everything from 20° to 60° was
impassable while the configured limit read 65°, and 70° climbed at 94% of walk speed — so
steeper was easier. Velocity is now integrated, and only the component pushing into
something unwalkable is cancelled.

**A per-player terrain window cost 43x at scale.** Each motor building its own following
heightfield costs 90.7 ms per tick at 64 players; one shared static surface costs 2.09 ms.
It looks per-player because the *window* is per-player. Servers must pass
`sharedSurfaceSpanMetres`.

**Correction telemetry measured its own output.** `reconcile` held a reference to
`motor.state.position` as the "before" value and then teleported, which mutates that object
in place, so every after-minus-before reading was exactly zero — including the test
assertions, which passed vacuously.

**Resent commands were queued twice.** A client repeats its unacknowledged tail; a command
still sitting in the queue passed a `tick > acknowledgedTick` check and was enqueued again.
The queue grew until the overflow guard discarded genuine input and the server fell
permanently behind. Dedupe tracks the highest tick ever *queued*, not the highest consumed.

**Draining exactly one command per tick never recovers from loss.** Every lost packet
arrives later as a resend, deepening the queue by one, forever. The server drains a second
command while catching up.

**A join teleported the player about 6 m,** because the welcome packet carried no spawn
position and the client guessed the origin while the server had placed it elsewhere. The
welcome now carries the resolved feet position.

**Snap-to-ground stalls the character on flat ground.** Walking axis-aligned across a flat
heightfield, snap resolves against a lattice seam and returns zero movement for one tick —
6 full stops per 2000 ticks at 1x lattice, 30 at 2x. Autostep and the snap distance are both
irrelevant; only disabling snap removes it. It is now enabled only when the ground ahead
falls away faster than the downward ground-stick can follow. **Turning while walking hides
this completely**, so any test for it must walk dead straight.

**Chrome suspends `requestAnimationFrame` entirely in a hidden tab** — measured at 0 per
second, not throttled. A simulation loop driven by animation frames stops dead when
backgrounded and floods the server on return. The session harness drives its fixed tick from
a timer and abandons the backlog on becoming visible.

## 7. Terrain collision

Two surfaces, chosen by who is asking:

- `TerrainCollider` — a window that re-centres on the source cell lattice as the subject
  moves. No edges, because the map tiles forever. Client shape.
- `StaticTerrainCollider` — one fixed heightfield for a whole region, built once and shared.
  Has real edges; the caller must keep the match inside it. Server shape.

Both sample the height source at `DEFAULT_SUBDIVISION` steps per source cell. That is not a
quality knob: bullets resolve the BILINEAR surface through `CompositeWorldQuery` while a
Rapier heightfield is two TRIANGLES per cell, and the two disagree by the cell's saddle term
everywhere except the corners. One subdivision step takes worst disagreement from 0.195 m to
0.031 m and removes the grazing-shot disagreements entirely, for four times the height
memory.

**Two collision representations coexist and this is deliberate** (`plans/2026-08-02-...` §6).
Rifle rounds never become Rapier bodies.

## 8. Wire format

9 bytes per command up, 24 bytes per player down, no field names. Look angles and velocities
ride as int16; positions as float32 because quantising them needs an agreed origin.

At 64 players and a 20 Hz patch rate with no visibility culling, that is about 31 KB/s per
client, against roughly 1.28 MB/s for the same content as JSON.

The transport interface has four methods and nothing above it knows which implementation is
in use. The `ws` implementation and the harness are **explicitly disposable**; §5 of the
decision record defers the session framework until the measurements exist.

## 9. Controls and URLs

The motor is selected independently of the scene. `?scene=motor` is movement alone;
**`?scene=scope&motor=1`** is the weapon carried on a collided body, which is the
combination worth playing. Either way the motor replaces the terrain spike's fly camera —
the two are mutually exclusive because both write the camera every frame.

| Input | Effect |
| --- | --- |
| W A S D | move |
| Shift | sprint (standing, moving forward) |
| Space | jump |
| X / C / Z | stand / toggle crouch / toggle prone |
| V | toggle the third-person collider capsule |
| drag | look |

| Query | Purpose |
| --- | --- |
| `&climb=<deg>` | slope limit; SOFT, speed falls off rather than gating |
| `&slide=<deg>` | where sliding begins; forced above the climb limit |
| `&walk=<m/s>` | standing walk speed |
| `&jump=<m/s>` | jump launch speed |
| `&step=<m>` | maximum step-up height |

Session harness: `npm run session:server` and `npm run session:client`, then two **separate
visible windows** — not two tabs, per §6.

## 10. Verification

- `npm test` — 36 motor and networking tests inside the suite.
- `npm run motor:bench` — dense-room cost.
- `tools/motor-bench/prediction-quality.ts` — correction rate under latency and loss.
- `tools/motor-bench/collision-agreement.ts` — the two-representation disagreement.

Two tests exist specifically because a weaker version of them passed through a real bug:
the flat-ground walk must go dead straight, and the climb test must sweep a range of
gradients rather than sample one.

## 11. Deferred

Cross-runtime divergence on genuinely different hardware, dense-room cost under a real
server process, correction behaviour for a whole room rather than one player, client cost of
64 interpolated remotes, and collision agreement measured on real extracted terrain rather
than a synthetic grid. All are listed with their blockers in the measurements document.

Beyond measurement: vehicles, animation on the capsule, weapon integration, and the session
framework choice itself.
