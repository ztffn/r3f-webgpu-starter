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
- 45 headless tests under `tests/motor/`, running in bare Node with no browser globals.

Weapon handling reads the motor: `?scene=scope&motor=1` carries the weapon on a collided
body, and `WeaponHandlingContext` gets stance, planar speed and real grounded state from
`MotorState` instead of inferring them from the camera. Rounds leave the motor's eye rather
than the camera, aim intent and reloading slow the player, and sprinting refuses the shot. That last one is the point — camera
differentiation cannot tell you the player is airborne, so before this `grounded` was
whatever the app's fly/on-foot toggle said and `airborneDispersionRadians` never applied.

What does **not** exist: matchmaking, reconnection, persistence, anti-cheat, vehicles, and
animation. On the weapon side, recoil does not push the body.

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
| `net/GameServer.ts` | authority: command intake, tick, broadcast, room-scope state | which socket library is in use |
| `net/GameClient.ts` | prediction, reconciliation, remote interpolation, the room-state snapshot | rendering, input devices |
| `net/LoopbackTransport.ts` | an in-process link with simulated latency and loss | production use |
| `net/ColyseusProtocol.ts` | the room name and message envelopes, SDK-free | any Colyseus import |
| `net/ColyseusTransport.ts` | the ClientTransport over `@colyseus/sdk` | packet meaning |
| `tools/game-server/` | the authoritative Colyseus server on the real prepared terrain | gameplay logic beyond GameServer |
| `fps/MotorControls.tsx` | DOM input to commands, motor state to camera | any simulation |
| `fps/useRoomVisuals.ts` | room state as a React value, so nothing above the seam knows Colyseus | deciding the weather |
| `df2/visualDials.ts` | the 25 dials: wire identity, legal range, clamp, and how to read/write each | knowing about the network |

## 3. The one rule that keeps this shared

**`src/motor/` and `src/net/` import no Three.js and no React at runtime.** Type-only
imports are fine because they erase. This is what lets a Node server construct and step the
identical code, and `tests/motor/*.test.ts` enforce it by loading these modules in bare
Node — if a runtime Three.js import appears, those files stop loading.

`fps/MotorControls.tsx` is the only adapter, and it is presentation only.

**Two `src/df2` modules are now under the same rule**, because the Node server imports
them: `weather.ts` (the preset table and wire order) and `visualDials.ts` (the dial
table and the clamp). Both are Three-free at runtime only because every Three-touching
import in them is `import type`. A value import from one of those breaks the server,
and `tests/motor/session.test.ts` loading both in bare Node is what enforces it —
that check already caught `weather.ts` importing `./config` without a file extension,
which Vite resolves and Node does not.

**`src/combat/` carries the rule wholesale (2026-08-04).** The entire ballistic
core — definitions, terminal model, hitscan closed form, and the projectile
integrator — moved out of `src/fps/` precisely so the authority could run it, and
`tests/motor/server-ballistics.test.ts` loads it in bare Node. Vectors there are
plain `{x, y, z}` (`combat/math.ts`); `THREE.Vector3` satisfies the shape
structurally, which is why the browser implementations did not have to change.

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
8. **Weapon INTENT travels in the command; weapon STATE does not.** `WeaponSystem` owns
   ADS and the reload. Anything that changes movement must be replayable by a server from
   the command stream alone, so the motor takes intent bits and never reads weapon state.
   A weapon that refuses to enter ADS still slows the player, and that is the correct
   trade. The reverse direction is `MotorState.sprinting`, which is RESOLVED state — the
   raw Sprint bit is not enough, because aiming, crouching and standing still all suppress
   it, and the weapon blocks on the resolved answer. `MotorState.aiming` (2026-08-03)
   flows the same direction but with weaker semantics: it echoes the Ads intent bit
   exactly as the motor consumed it — the bit that already scaled speed — so remote
   presentation can raise the rifle. It is an intent MIRROR, not resolved weapon truth;
   nothing gameplay-side may read it as ADS state.
9. **Parameter properties are forbidden.** `--experimental-strip-types` runs in strip-only
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

10 bytes per command up, 28 bytes per player down (health rode in as the 28th on
2026-08-03), no field names. Look angles and velocities
ride as int16; positions as float32 because quantising them needs an agreed origin. Pitch and
the stance blend (`previousStance`, `stanceProgress`) ride in the snapshot since 2026-08-03 —
they were decode-side fakes before that, which was harmless for capsules and wrong the moment
a remote had an aim direction.

**Input bits are u16, not u8.** They outgrew a byte the moment aim intent became a movement
input, and a u8 there does not fail — it silently drops the bit, so the server simply never
sees that input. `tests/motor/session.test.ts` round-trips the whole bitfield rather than a
sample, so the next bit added cannot repeat it.

### 8.1 Room state — the low-frequency packet (2026-08-03)

`PacketType.RoomState` carries everything the server owns that is neither per-player
nor per-tick: `type u8 + flags u8 + weather u8 + dial count u8 + (dial id u8 + value
f32) * n`. The weather is an index into `WEATHER_PRESET_IDS` (`src/df2/weather.ts`),
flags bit 0 says whether this room accepts dial changes from its clients, and the
dials are a sparse override layer on the preset (§8.2). Sent **on connection, right
after the welcome, and again only when something changes** — there is no periodic
rebroadcast, so a client that loses the packet keeps the old room until it
reconnects. That is the right trade for something that changes a handful of times a
match; the alternative is paying for it at the patch rate forever to say nothing
happened.

**One packet, and that was the second attempt.** Weather and dials shipped as two
packet families first and the split leaked immediately: the bit that gates DIALS had
to travel in the WEATHER packet, a join sent two packets to describe one room, the
client needed two single-consumer callbacks that published the same object, and the
server ran two broadcast disciplines for one class of state. They are one concept, so
they are one packet.

**Why the codec and not Colyseus Schema,** which is what the adoption record reserved
for lobby-scope state. Three reasons, and they generalise:

1. **Ownership.** Weather here is not cosmetic — fog IS concealment, and the plausible
   endgame is the server consulting it in a visibility check. That logic lives in the
   transport-agnostic authority layer, so the state has to live where a gameplay
   consumer can reach it, not in the Colyseus room shell where only the transport can.
2. **Testability.** A packet flows through the `ServerTransport` seam, so the Node
   loopback suite covers join sync, change broadcast and short-buffer hardening end to
   end. Schema sync bypasses that seam and would have been the first piece of server
   state invisible to the harness.
3. **The adoption decision is intact.** Its rule was that the 60 Hz hot path never
   rides Schema; it permitted Schema for metadata and never mandated it. A packet sent
   on join and on change is nowhere near the hot path.

Two traps this packet is already shaped around. **Both wire orders are append-only** —
`WEATHER_PRESET_IDS` and `VISUAL_DIALS` — because an entry's index IS its wire value:
reordering or deleting one repoints every connected client at a different sky or a
different dial, and it fails as "the other player sees different fog", never as an
error. `session.test.ts` pins both. And the decoder **reports an unknown weather index
raw rather than clamping it**: a newer server can legitimately name a preset that
shipped after this client, so `weatherPresetAt` falls back to neutral daylight and the
codec stays dumb.

Time of day and a wind seed are the likeliest fields to join it. **Damage and
world-object state are not** — they need per-player attribution and entity lifetimes
that a sparse id-to-float map cannot carry, so they want their own shape rather than a
premature general channel built from two samples that are both global scalars.

### 8.2 Admin visual dials (2026-08-03)

The preset is the BASE layer; the 25 dials in `src/df2/visualDials.ts` are a sparse
OVERRIDE layer on top. An admin moves a dial, the server clamps and stores it, and
every client in the room gets the result on the next patch tick.
`PacketType.SetVisualDial` carries one asked-for change up; the result comes back in
the room packet.

**One table, not two.** A dial's index in `VISUAL_DIALS` is its wire identity, its
range bounds the clamp, and its accessors are what the panel reads and writes — all in
one array, because a server clamping to a range the panel does not show appears only
as "the slider stops responding near the top". The module is Node-safe: every type
import in it is `import type`, so the server pulls no Three. **A value import from any
of those four modules breaks the server, and only the Node tests will tell you** —
which is exactly how `weather.ts`'s extensionless `./config` import was caught, having
worked fine in Vite.

**The clamp is injected as a FUNCTION, not as a range table.** The server clamps on
the way in and `applyVisualDials` clamps again on the way out, so two copies of that
arithmetic diverge the moment either gains a rule — step snapping, a per-dial default
— and the only symptom is a slider settling somewhere the room never asked for.
`src/net` cannot import `src/df2`, so `GameServerOptions.clampVisualDial` takes the
one implementation across the seam.

Four things this is shaped around, each a bug rather than a preference:

1. **The packet always carries the COMPLETE dial set, never a delta.** A delta cannot
   express a dial being cleared — an absent id means "unchanged" — so supporting one
   cost a complete-versus-delta flag on the wire, a merge-or-replace branch on the
   client, and a dirty set beside the values on the server. Sending everything costs 5
   bytes per dial anyone has touched, at most 128 bytes, at the patch rate, only while
   an admin is dragging. Against the ~35 KB/s a single client already spends on
   snapshots the delta was buying nothing and charging three pieces of state that had
   to agree.
2. **Writes are coalesced to the patch tick.** A dragged slider fires an input event
   per pixel; forwarding each is a send per client per event, roughly 3800 a second at
   64 players from one mouse. Batching in `GameServer` bounds it to the patch rate
   regardless of how fast a client talks, which also stops a hostile client using it
   as an amplifier. **Weather shares that path**, so a change lands within one patch
   rather than instantly — irrelevant at 50 ms, and one flush path instead of two.
3. **The capability is advertised, not discovered.** Refusals are silent, so without
   the flags bit a panel cannot tell "refused" from "not applied yet" and an ordinary
   player sees live-looking sliders that do nothing.
4. **Two gates, not one:** `allowClientVisualDials` AND an injected clamp. A server
   handed no clamp refuses everything, so the capability has to be wired on purpose.
   The client path is gated; `GameServer.setVisualDial` is the trusted server-side
   entry point and game code calls it directly.

**The client exposes `subscribeRoomState` / `getRoomState`, not an assignable
handler** — the pair `CombatTelemetry` established. Room state has more than one
interested reader (the weather panel today, a HUD line or the concealment reader
tomorrow) and a lone callback field lets the second silently displace the first, which
reads as "the sky stopped changing" with no error. The state object is replaced
wholesale rather than mutated, which is what makes it a valid `useSyncExternalStore`
snapshot and lets `useRoomVisuals` hand its map straight out with no defensive copy.

Networked, a panel dial is an **ask, not a write** — nothing is applied locally, so a
clamped value shows as the slider settling somewhere else rather than as the picture
and the room disagreeing. Two exceptions, both deliberate: the readout moves
optimistically while a slider is held, because the echo lags by up to a patch and
adopting it mid-drag reads as the control fighting back; and the resync returns the
same array when nothing moved, so React bails out instead of committing a render on
every packet.

**`DF2Scene` writes the room's visuals in ONE effect**, preset first and overrides
second, as two adjacent statements. It was three effects sequenced only by their
position in the file, enforced by a comment: these uniforms are shared, there is no
lint rule here to catch a reordered hook, and the failure is silent — a preset switch
wipes the room's dialled fog.

Not replicated, deliberately: `?bladecount=`, which is baked at load and needs a
reload. Of what is replicated, only rain intensity and blade field radius move a
*drawn* count, and both are bounded by a pool allocated per client at load — an admin
can push a client to its own ceiling and no further.

### 8.3 Combat claims and the hybrid ballistic authority (2026-08-04)

Three uplink claims, all sequence-deduped like the command queue, all refused
silently and counted:

- **Fire** (15 bytes): `type u8 + tick u32 + sequence u16 + yaw i16 + pitch i16 +
  viewTick u32`. No origin (the server uses its own eye for the shooter's blended
  stance) and **no weapon** — the server already knows what is in hand. `viewTick`
  is the shooter's RENDER TICK — the moment in the room's past their screen was
  showing (§8.4) — and is the rewind target.
- **SelectWeapon** (4 bytes): `type u8 + sequence u16 + index u8` into the
  canonical `WEAPON_DEFINITIONS` order (`src/combat/weaponDefinitions.ts`), which
  is therefore append-only.
- **Reload** (3 bytes): `type u8 + sequence u16`. Select and reload share one
  sequence counter; the stream is ordered, so "consumed already" is one number.

**The server owns the loadout record**: equipped index, per-weapon magazines and
reserves, per-weapon cadence clocks (per weapon, or a sniper shot would lend its
75-tick cooldown to the sidearm you switch to), a 0.35 s switch clock mirroring
`LoadoutSystem`, and the reload timer, settled lazily. The client's `WeaponSystem`
runs the same rules for prediction, so an honest client never trips a gate; the
gates exist for the client that stops being honest. Death refills on respawn.

**Damage is the shared ballistic model** (`src/combat/`, docs/11 §12), resolved as
a hybrid:

- **Inside the ammunition's hitscan horizon** — `v₀·√(2ε/g)`, ε = 5 cm of hidden
  drop; ~80 m for .308, ~35 m for 9mm — the shot is instant, resolved by the exact
  flat-fire decay against capsules **rewound to viewTick** (a 32-tick ring,
  claims clamped to 250 ms): lag compensation where twitch fights happen.
- **Beyond it**, the round leaves the horizon as a continuation spawn into the
  same `BallisticProjectileSystem` the client runs — drop, drag, wind and further
  penetrations against LIVE state. At range, flight time dwarfs latency and
  holding lead is the game. A parity test pins the two solutions to within 1% at
  the horizon.

Overpenetration works through players — a capsule is one blended-stance diameter
of flesh — and through the same 8-interaction budget as everything else. Health
still moves in exactly one place (`damagePlayer`, via each peer's `Damageable`)
and still rides only the snapshot; nothing about the health flow changed.

Because the server integrates far shots with `DEFAULT_BALLISTIC_ENVIRONMENT`, a
networked client ignores `?ammo=` and `?windx/z=` — same rule as `?weather=`.
Replicating wind through RoomState belongs to the weather-authority work.

Still trusted within bounds: the claimed direction (clamped to 0.2 rad around the
server's look, since sway/recoil/dispersion are client-side until dispersion is
recomputed server-side from the deterministic seed) and the claimed weapon
selection itself (no server-owned inventory yet — a client may select any of the
four dev weapons, but only a weapon it then actually fights with).

### 8.4 Entity interpolation — remotes render the exact past (2026-08-04)

Remote players are drawn a FIXED interval in the past: two patch intervals
(100 ms at the default 20 Hz), interpolated between the two snapshots that
bracket a free-running render clock (`GameClient.interpolateRemotes`). Position,
yaw (shortest-arc), pitch, velocity and the stance blend all interpolate;
`remote.state` IS the interpolated presentation state, so the animator and aim
rig get smooth values without knowing any of this. The clock advances on wall
time and slews gently toward `latest snapshot − delay`, snapping only after a
real stall; past the newest snapshot a remote HOLDS rather than extrapolates —
dead reckoning guesses wrong exactly when a player jinks, which in a shooter is
the moment that matters.

This replaced an exponential chase toward the latest snapshot (rate 12), and the
reason is §8.3 as much as smoothness: the chase trailed a moving target by
roughly `v × 80 ms` — half a metre at a sprint, more than a capsule radius — and
that trailing position was NEVER a state the server could name, so the lag
compensation rewound to a world the shooter had not actually seen. With the
render clock, "what the shooter saw" is a server tick by construction:
`fire()` claims `renderTick` and the rewind restores the shooter's pixels to
within one tick. The end-to-end test aims at the interpolated soldier of a
sprinting victim — deliberately more than a radius from the live position — and
must hit. The delay rides inside the 250 ms rewind cap with room for network
latency; a headless client that never pumps interpolation falls back to
claiming the raw latest snapshot tick.

The known costs, accepted: everyone else is 100 ms in the past (imperceptible
next to the flight-time and leading skills this game already demands), and the
"shot around the corner" window for the victim grows by the same 100 ms — the
standard trade, bounded by the rewind cap.

The motor is selected independently of the scene. `?scene=motor` is movement alone;
**`?scene=scope&motor=1`** is the weapon carried on a collided body, which is the
combination worth playing. Either way the motor replaces the terrain spike's fly camera —
the two are mutually exclusive because both write the camera every frame.

**`&net=1`** puts the motor on the authoritative game server: `MotorControls` predicts
through `GameClient` over the Colyseus transport, remote players render as animated
soldiers driven by snapshot state (`src/fps/RemotePlayers.tsx`, with a stance-blended
capsule fallback while the GLB loads), and the HUD gains a `Net` row (connecting /
playing / dropped). Start the server with `npm run game:server` (port 2567; `&server=`
overrides the URL). Both sides sample the same prepared terrain — the browser through
`loadTerrain`, the server through `tools/game-server/terrain.ts` — because any terrain
disagreement reconciles forever. URL tuning overrides are ignored networked, for the same
reason.

**`?weather=` is also ignored networked** (2026-08-03), and for a gameplay reason rather
than a consistency one: fog is concealment, so two players in one match under different fog
ranges is a fairness bug. The room's preset arrives right after the welcome and overrides
whatever the URL asked for, and the debug panel's preset buttons go **disabled with a note
saying why** — they are refused rather than reverted, because nothing rebroadcasts to
correct a local switch. The panel's dials still work; they write uniforms locally and change
nothing anyone else sees.

Server side, the room picks it: `DF2_WEATHER=<preset id>` fixes one for every room,
`=random` gives each room its own, `=rotate` cycles every 60 s. Rotate exists to make the
CHANGE half verifiable by looking at it — with a fixed preset a live session only ever
exercises the join path, and "the sky changed in both windows at the same moment" is the
only check that proves a change reaches an already-connected client.

**The 25 dials ARE available networked, to an admin** (§8.2). `DF2_ADMIN=1` on the server
makes every client in that server's rooms an admin, and the panel then changes the room for
everyone instead of just the local view. It is a development flag and deliberately blunt:
right for two windows on one machine, wrong for anything someone else can reach, because
the fog an admin can lift is the concealment the game is built on. Without the flag the
sliders go read-only and say so. Offline — no `&net=1` — every dial writes its uniform
directly exactly as before, which is still the right loop for authoring numbers to commit
back into `weather.ts`.

| Server env | Effect |
| --- | --- |
| `DF2_WEATHER=<id>` | every room runs that preset |
| `DF2_WEATHER=random` | each room picks its own at creation |
| `DF2_WEATHER=rotate` | each room cycles preset every 60 s |
| `DF2_ADMIN=1` | connected clients may dial the room's visuals for everyone |

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
visible windows** — not two tabs, per §6. The harness stays on its synthetic sine terrain;
the game server above is the one that runs the real map.

## 10. Verification

- `npm test` — 45 motor and networking tests inside the suite (134 in total).
- `npm run motor:bench` — dense-room cost.
- `tools/motor-bench/prediction-quality.ts` — correction rate under latency and loss.
- `tools/motor-bench/collision-agreement.ts` — the two-representation disagreement.

Two tests exist specifically because a weaker version of them passed through a real bug:
the flat-ground walk must go dead straight, and the climb test must sweep a range of
gradients rather than sample one.

## 11. Deferred

Cross-runtime divergence on genuinely different hardware, correction behaviour for a whole
room rather than one player, client cost of 64 interpolated remotes, and collision
agreement measured on real extracted terrain rather than a synthetic grid. All are listed
with their blockers in the measurements document. Dense-room cost under a real server
process is answered: `tools/transport-bench/run.ts`, recorded in
`plans/2026-08-03-colyseus-transport-evaluation.md`.

**The catch-up drain can spiral unrecoverably.** One stall that pushes every peer past
`TARGET_BUFFER_DEPTH` at once makes each later tick run a full room step per backed-up
peer — 65 × ~2.1 ms ≈ 137 ms per tick at 64 players, measured — while consumption stays
below the 60 Hz arrival rate, so the queues pin and discard input forever. A ~200 ms GC
pause could trigger it in production. Deferred fix: a global catch-up budget per tick, or
catch-up steps that step only the lagging motor. Evidence in the 2026-08-03 evaluation
record §4.

Beyond measurement: vehicles, animation on the capsule, weapon integration, and the session
framework choice itself — resolved 2026-08-03 in favour of Colyseus (pending sign-off), see
the evaluation record.
