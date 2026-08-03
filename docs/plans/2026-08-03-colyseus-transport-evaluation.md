# Colyseus evaluation — evidence and adoption recommendation

**Status:** recommendation: **adopt**, scoped to transport and lifecycle. Awaiting sign-off;
no production server code has been written on it.

**Date:** 2026-08-03

**Resolves:** the provisional in `2026-08-02-multiplayer-motor-and-transport-decisions.md`
§5, on the evidence that section demanded. Criteria were stated before the measurement:
adopt if Colyseus supplies room lifecycle, matchmaking and reconnection without forcing
Schema onto the 60 Hz path and adds materially less than ~2 ms/tick at 64 clients; decline
if Schema is forced onto the hot path, a fixed-tick authoritative loop does not fit, or the
per-room cost is comparable to the simulation itself.

## 1. What Colyseus provides today (0.17 stable, checked 2026-08-03)

- **Versions.** `@colyseus/core` 0.17.46 (published 2026-07-30), Node >= 22 floor. Actively
  maintained; 0.18 exists as a prerelease on the `next` dist-tag.
- **No client prediction or reconciliation in stable.** The official FAQ: "Not yet —
  client-prediction is planned for a future release." The prior session's working assumption
  is confirmed: `src/net/GameClient.ts` (prediction, replay, reconciliation, interpolation)
  is not redundant and stays ours. Note: **0.18 (prerelease) ships first-party prediction
  APIs** (`room.input()`, `predict.reconciler` rollback/replay, dead reckoning, lag-comp
  rewind) demonstrated in the official `colyseus/prediction-playground` repo — undocumented
  and subject to change. Do not build on it; re-evaluate against `GameClient` when 0.18
  reaches stable.
- **Raw binary both directions, Schema fully avoidable.** Client `room.sendBytes`, server
  `onMessageBytes` / `client.sendBytes` / `broadcastBytes`, and `patchRate = null` disables
  Schema patching entirely. Confirmed in the docs, in the installed type definitions, and
  exercised end-to-end by the bench below. Schema can be confined to lobby metadata exactly
  as §5 proposed.
- **Fixed-tick loop fits.** `setSimulationInterval` is a plain interval (not
  drift-compensated — same as our current loop); simulation and patch broadcast are
  decoupled. The bench ran `GameServer`'s own unmodified `setInterval` loop inside a room
  with no friction.
- **Lifecycle surface** (the reason to adopt): `onAuth`/`onJoin`/`onLeave`/`onDispose`,
  `allowReconnection` plus 0.17's automatic client reconnection with `onDrop`/`onReconnect`
  hooks, matchmaking verbs with filters, seat reservation, consented-vs-drop leave codes.
- **Transport.** `@colyseus/uwebsockets-transport` 0.17.21 (2026-07-24) is current and the
  docs' "recommended transport for production". Caveats: 4096-byte default max payload (our
  largest packet, a 64-player snapshot, is 1,546 bytes) and a `uwebsockets-express` peer
  dependency; the default ws transport needs `express`. At our scale the two measured
  identically, so the default is fine to start and uWS is a config swap.
- **No public dense-room benchmark exists** — no colyseus/benchmarks repo, no CPU-per-tick
  numbers anywhere for a 64-client room. The numbers below appear to be the first.

## 2. Method

`tools/transport-bench/` runs the **identical `GameServer`** behind three
`ServerTransport` implementations — raw `ws` (the session-test shape), Colyseus with the
default ws transport, Colyseus with the uWS transport — via a bridge Room that maps
`onJoin`/`onMessageBytes`/`onLeave` onto the transport seam. 60 Hz tick, 20 Hz patch,
shared static surface (1024 m span), the dense-room bench's scripted commands and 30 m
spawn disc. N clients send 3-command unacknowledged tails at 60 Hz from **forked load
processes** and start sending only on a "go" after the room is full and drained. 30 s
measured after a 5 s settle. Colyseus is configured exactly as §5 proposed: no Schema
state, `patchRate: null`, raw bytes both ways.

## 3. Results (Node 22.21.1, Apple Silicon, 600+ measured ticks per row)

| Players | Transport | Mean ms | p99 ms | CPU ms/tick | Ticks/s | Discarded |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 16 | raw ws | 1.85 | 6.65 | 2.16 | 60.3 | 0 |
| 16 | colyseus ws | 2.33 | 8.75 | 2.54 | 59.6 | 0 |
| 16 | colyseus uWS | 2.45 | 7.92 | 2.57 | 59.6 | 0 |
| 32 | raw ws | 3.45 | 9.32 | 3.76 | 60.1 | 0 |
| 32 | colyseus ws | 3.29 | 9.46 | 3.69 | 60.3 | 0 |
| 32 | colyseus uWS | 3.30 | 8.58 | 3.57 | 60.2 | 0 |
| **64** | **raw ws** | **4.29** | **10.04** | **4.95** | **59.0** | **0** |
| **64** | **colyseus ws** | **4.40** | **9.42** | **5.14** | **59.2** | **0** |
| **64** | **colyseus uWS** | **4.40** | **9.09** | **5.10** | **59.5** | **0** |

**Colyseus's own overhead at 64 clients: +0.11 ms tick wall, +0.20 ms process CPU per
tick** over raw `ws`, with p99 slightly better. Against the ~2 ms criterion it passes by an
order of magnitude. The raw-ws rows also close the measurements record's "same run under an
actual server process with sockets attached" gap: 64 players with real sockets costs
4.29 ms of the 16.67 ms budget against 2.09 ms for the bare loop.

## 4. Two artifacts the bench surfaced — both matter beyond Colyseus

1. **A saturated load generator reads as server overhead.** The first 64-client runs put
   all 64 Colyseus SDK clients in one Node process; the SDK is far heavier per client than
   a raw socket, the process starved, its sends turned bursty, and the server showed
   136–207 ms ticks that had nothing to do with Colyseus. Sharding clients across 4
   processes removed the effect entirely. `commandsDiscarded > 0` is the tell that a run
   degenerated and its numbers are invalid.
2. **`GameServer`'s catch-up drain has an unrecoverable amplification spiral** (ours, not
   Colyseus's — raw ws can trigger it too). One stall long enough to push **all** peers past
   `TARGET_BUFFER_DEPTH` at once makes every later tick run one full room step per
   backed-up peer — at 64 players, 65 × ~2.1 ms ≈ 137 ms per tick, measured exactly. At the
   resulting ~7 ticks/s the server consumes at most 14 commands/s per peer against 60/s
   arriving, so the queues pin at `MAX_QUEUED_COMMANDS` and discard input forever. In
   production a single ~200 ms GC pause or CPU spike could do it. Fix direction: a global
   catch-up budget per tick, or catch-up steps that step only the lagging motor instead of
   the whole room. Recorded as deferred work in `12-...md` §11.

## 5. Decision against the stated criteria

| Criterion | Evidence | Verdict |
| --- | --- | --- |
| Lifecycle, matchmaking, reconnection supplied | §1 lifecycle surface, verified current docs | yes |
| Without Schema on the 60 Hz path | raw-bytes APIs + `patchRate: null`, exercised by bench | yes |
| Fixed-tick authoritative loop fits | `GameServer`'s own loop ran unmodified in a room | yes |
| Adds materially less than ~2 ms/tick at 64 clients | +0.11 ms wall / +0.20 ms CPU | yes |

**Adopt**, scoped: Colyseus replaces the disposable transport layer
(`src/net/WebSocketTransport.ts`, the `WsServerTransport` in
`tools/session-test/server.ts`, ~150 lines) and supplies rooms, matchmaking and
reconnection. It does **not** replace `src/motor/`, `src/net/GameClient.ts`, the codec, or
`GameServer`'s command-queue behaviour. The server side becomes a Colyseus `Room` owning a
`GameServer`-shaped core — a moderate refactor, since `GameServer` currently owns its own
tick loop and peer map; the bench's bridge (`tools/transport-bench/colyseus-room.ts`) shows
the minimal mapping. Not adopted: Schema on the hot path, the 0.18 prediction prerelease.

## 6. Costs accepted

New dependencies (`@colyseus/core`, `@colyseus/ws-transport`,
`@colyseus/uwebsockets-transport`, `@colyseus/sdk`, plus `express` and
`uwebsockets-express` peer deps — installed as devDependencies for the bench, to be
promoted deliberately at integration time), the Node >= 22 floor (already satisfied), and
tracking a framework's release cadence, including the 0.18 migration eventually.
