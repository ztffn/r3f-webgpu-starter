# Motor measurements

**Status:** live. Answers open measurements from
`2026-08-02-multiplayer-motor-and-transport-decisions.md` §7 as they are taken.

**Date:** 2026-08-02

Each section below names the §7 measurement it addresses and states what is still
missing. A measurement is only closed when the number came from running something.

## Rapier variant and headless viability

`@dimforge/rapier3d-compat` 0.19.3, non-SIMD. Verified in Node 22.21.1 with the project's
existing test flags and no browser globals: `window` absent, `RAPIER.init()` 34.9 ms,
kinematic capsule plus character controller settles correctly.

Two Rapier API facts cost time and are recorded so they are not rediscovered:

- `ColliderDesc.heightfield(nrows, ncols, heights, scale)` takes **cells**, not samples.
  The heights array must hold `(nrows + 1) * (ncols + 1)` entries. Passing sample counts
  throws `unreachable` from the WASM boundary with no useful message.
- **Nothing can be queried before the first `world.step()`.** The query pipeline's
  acceleration structure is built during a step, so ray casts, shape intersections and the
  character solver all silently return nothing on a world that has never stepped. This
  presents as "my collider does not exist".

Height array layout is column-major with columns along +X and rows along +Z. Verified
against a deliberately asymmetric surface in `tests/motor/character-motor.test.ts`, so a
transpose fails the suite rather than shipping.

## §7.2 Dense-room cost — substantially answered

64 fixed-tick motors in one room, all moving and turning, packed into a 30 m disc so they
genuinely contend. 600 measured ticks after 120 warmup, Node 22.21.1, Apple Silicon,
60 Hz tick giving a 16.67 ms budget.

| Players | Surface | Mean ms | p99 ms | Budget | Motor share |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | shared | 0.042 | 0.194 | 0.3% | 88% |
| 16 | shared | 0.506 | 1.048 | 3.0% | 98% |
| 32 | shared | 1.007 | 1.819 | 6.0% | 99% |
| **64** | **shared** | **2.088** | **3.448** | **12.5%** | **99%** |
| 16 | per-player | 5.586 | 11.491 | 33.5% | 99% |
| 32 | per-player | 22.499 | 41.734 | 135.0% | 99% |
| 64 | per-player | 90.679 | 144.165 | 544.1% | 100% |

**The terrain surface is the whole result.** Giving each motor its own following
heightfield window costs 90.7 ms per tick at 64 players — 5.4x over budget and
unshippable. One shared static surface costs 2.09 ms, a 43x difference. The per-player
row is kept because it is the shape the motor had first, and it is an easy mistake to
repeat: the collider looks per-player because the *window* is per-player.

Consequences:

- Simulation cost does not gate the framework choice. A custom room loop at 64 players
  uses an eighth of the tick budget, so the Colyseus question is now about Colyseus's own
  overhead, not about whether Rapier can keep up.
- Cost is essentially linear in players and 99% of it is inside the motors, not the shared
  world solve. Rapier's broad phase over 64 kinematic capsules is close to free.
- A client-side room of one costs 0.03–0.04 ms per tick, so prediction is not a frame
  budget concern.

Snapshot size, one client receiving the entire room uncalled at the full 60 Hz tick:

| Players | JSON | Hand-packed |
| ---: | ---: | ---: |
| 16 | 327 KB/s | 23 KB/s |
| 64 | 1.28 MB/s | 92 KB/s |

Hand-packed is 24 bytes per player. At a realistic 20 Hz patch rate with no visibility
culling, 64 players is about 31 KB/s per client. This supports §5's decision to keep the
hot path on hand-packed binary rather than Colyseus Schema.

**Still missing:** behaviour as tick and patch rates diverge, and the same run under an
actual server process with sockets attached rather than a bare loop.

## Open

- **§7.1 cross-runtime divergence** — not started. Needs the same recorded command stream
  through the motor in a browser and in Node. `tests/motor/character-motor.test.ts` proves
  same-runtime replay determinism, which is the weaker precondition.
- **§7.3 correction rate and magnitude** under latency and loss — needs transport.
- **§7.4 client cost of 64 remote interpolated entities** — not started.
- **§7.5 collision-representation disagreement** between the Rapier character world and
  `CompositeWorldQuery` — not started, and it is the one with a gameplay failure attached
  (being shot through cover you are standing behind).
