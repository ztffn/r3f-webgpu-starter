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

## §7.1 Cross-runtime divergence — first result, 3.4 cm

Two Chrome tabs running the real client against the Node server over real WebSockets, on
rolling terrain, several hundred reconciliations each:

| Client | Reconciles | Worst drift | Worst correction |
| --- | ---: | ---: | ---: |
| Chrome tab A | 542 | 0.0336 m | 0.0337 m |
| Chrome tab B | 542 | 0.0336 m | 0.0337 m |

Worst disagreement between a browser-predicted position and the Node authority is **3.4 cm**,
and both tabs report the identical figure, which suggests one specific event — most likely a
landing — rather than accumulating noise.

**This is a weak form of the measurement and must not be quoted as the strong one.** Chrome
and Node here are the same V8 and the same WASM build on one machine. The real question is
Chrome on ARM against a server on x86, and that remains unanswered. What this does establish
is that the replay path is sound: a browser motor rewound to the server's state and
replayed forward lands within centimetres of where it independently predicted.

## §7.3 Correction rate and magnitude — answered for a single player

One scripted player, 1800 ticks (30 s), 60 Hz tick, 20 Hz patch, through the real server,
client, codec and reconciliation over a simulated link.

| Link | Worst drift | Mean drift | Worst correction | Replayed | Dropped |
| --- | ---: | ---: | ---: | ---: | ---: |
| localhost | 0.401 m | 0.0024 m | 0.401 m | 0 | 0 |
| 20 ms LAN | 0.460 m | 0.192 m | 0.404 m | 1197 | 0 |
| 60 ms broadband | 1.302 m | 0.754 m | 0.753 m | 4775 | 0 |
| 60 ms + 2% loss | 1.459 m | 0.839 m | 0.893 m | 5184 | 0 |
| 120 ms + 5% loss | 2.828 m | 1.528 m | 1.840 m | 9482 | 0 |
| 250 ms + 10% loss | 4.666 m | 2.569 m | 4.666 m | 15960 | 0 |

Drift grows roughly linearly with latency, which is expected and is not divergence: the
client is legitimately ahead of the newest snapshot by about one round trip plus the patch
interval. Corrections stay under a metre out to 60 ms broadband. At 250 ms the worst
correction equals the worst drift, which is the 4 m hard-snap threshold firing — beyond
that the client stops replaying and simply accepts authority. No inputs were discarded in
any scenario.

Reproduce with `npm run motor:bench` and
`node --experimental-strip-types --experimental-specifier-resolution=node
tools/motor-bench/prediction-quality.ts`.

## Three bugs the measurements found

Recorded because each one was invisible until something was actually measured.

1. **The correction telemetry read its own output.** `reconcile` held a reference to
   `motor.state.position` as the "before" value and then teleported, which mutates that
   object in place. Every after-minus-before reading was therefore exactly zero, including
   the assertions in the session tests, which passed vacuously. Copy scalars, never alias
   mutable state, when measuring a delta across a mutation.
2. **A join teleported the player about 6 m.** The welcome packet carried no spawn
   position, so the client started its prediction at the origin while the server had placed
   it on a ring. The first snapshot corrected it. Worst drift fell from 5.97 m to 0.028 m
   once the packet carried the resolved feet position.
3. **Resent commands were queued twice.** A client repeats its unacknowledged tail; a
   command still sitting in the server queue passed the `tick > acknowledgedTick` check and
   was enqueued again. The queue grew, the overflow guard began discarding genuine input,
   and the server fell permanently behind. Dedupe now tracks the highest tick ever queued,
   not the highest consumed.

A fourth issue is a client design constraint rather than a bug: **Chrome suspends
`requestAnimationFrame` completely in a hidden tab** — measured at 0 frames per second, not
merely throttled. A simulation loop driven by animation frames stops dead when backgrounded
and then floods the server on return. The harness drives its fixed tick from a timer and
abandons any backlog on becoming visible again, letting the hard snap resolve the gap.

## §7.5 Collision-representation disagreement — answered, with a proposed tolerance

§6 accepts two representations of one world: characters collide against Rapier, bullets
against `CompositeWorldQuery`. This measures the gap using the real `HeightfieldWorldQuery`
on the bullet side and a real Rapier heightfield collider on the character side, both
reading one grid at 2 m cells.

**The cause is structural, not a tuning artefact.** The bullet side solves the BILINEAR
patch over each cell; Rapier's heightfield is two TRIANGLES over the same four corners.
They agree exactly at the corners and along the shared diagonal, and differ in between by
the cell's saddle term.

| Sampled where | Mean | p99 | Worst |
| --- | ---: | ---: | ---: |
| cell corners | 0.0000 m | 0.0000 m | 0.0000 m |
| cell centres | 0.0442 m | 0.1250 m | 0.1250 m |
| uniform random | 0.0147 m | 0.1102 m | 0.1246 m |

Exactly zero at corners is the signature of the bilinear-versus-triangulated explanation
being the whole story. Over a wider sampled area the worst case reaches 0.195 m.

Consequences measured directly, walking a character 3880 grounded ticks and comparing the
feet Rapier put them on against the surface a bullet would resolve underneath:

- bullet ground **above** the feet, meaning rounds stop in terrain the player cannot feel:
  worst 0.089 m
- bullet ground **below** the feet, meaning the player floats above the bullet surface:
  worst 0.185 m

And the failure that actually matters — a grazing shot at a prone target over a ridge, 3000
trials: **8 shots, 0.27%, resolved differently** between the two representations. When they
disagree the outcome is total rather than marginal: one says blocked, the other says clear.

### Proposed tolerance

**0.20 m of vertical surface disagreement at 2 m cells**, and about one grazing shot in
four hundred resolving differently at prone height. Anything worse than that is a
regression, not the known structural gap.

### The mitigation, tested

Sampling the same bilinear field onto a finer Rapier lattice shrinks the gap quadratically,
as the saddle-term explanation predicts:

| Rapier cell | Mean | Worst | Relative to 2 m |
| --- | ---: | ---: | ---: |
| 2.00 m | 0.0145 m | 0.1951 m | 1.000 |
| 1.00 m | 0.0037 m | 0.0310 m | 0.159 |
| 0.50 m | 0.0009 m | 0.0076 m | 0.039 |
| 0.25 m | 0.0002 m | 0.0019 m | 0.010 |

Halving the cell costs four times the terrain memory and buys roughly a fourfold reduction
in worst-case disagreement.

### Applied: `DEFAULT_SUBDIVISION = 2`

Shipped, and re-measured afterwards rather than assumed:

| | Before (1x) | After (2x) |
| --- | ---: | ---: |
| surface gap, uniform sampling | 0.195 m worst | **0.031 m** worst |
| surface gap at cell centres | 0.125 m | 0.000 m — now lattice points |
| feet above the bullet surface | 0.185 m | **0.094 m** |
| grazing shots resolving differently | 8 in 3000 | **0 in 3000** |

The gameplay failure this measurement exists to bound does not occur at all in the sample
after the change. Cost is four times the terrain height memory: a shared 1024 m server
surface goes from roughly 1 MB to 4 MB.

### The stall this uncovered, and why snap-to-ground is now conditional

Subdividing exposed a **pre-existing** defect rather than causing one. Walking axis-aligned
across flat ground, the character stops dead for exactly one tick when
`enableSnapToGround` resolves against a heightfield lattice seam:

| Rapier lattice | Full stops per 2000 ticks |
| --- | ---: |
| 1x | 6 |
| 2x | 30 |

More lattice steps means more seams, so subdivision multiplied an existing stutter fivefold
and a test caught it. Isolating the cause: autostep is irrelevant, the snap DISTANCE is
irrelevant, and disabling snap-to-ground removes the stalls entirely at every resolution.

Snap cannot simply be deleted — without it a character walking down a steep slope goes
ballistic and skips in arcs. But the motor already applies a downward ground-stick each
grounded tick, and that alone holds contact on gentle descents. `CharacterMotor` therefore
enables snap only when the ground ahead falls away faster than the ground-stick can follow.

After that change, at 2x lattice: zero stalls on flat ground, zero stalls on rolling
terrain, and zero airborne ticks walking down a 45 degree ramp with the feet never more
than 0.17 m off the surface. At 1x the same ramp produced 78 airborne ticks and 2.29 m of
float, so **2x is now strictly better than 1x on every measured axis**, not merely more
accurate. `tests/motor/character-motor.test.ts` pins both halves.

Reproduce with `node --experimental-strip-types --experimental-specifier-resolution=node
tools/motor-bench/collision-agreement.ts`.

## Open

- **§7.1 across genuinely different platforms** — the result above is same-machine,
  same-V8. Needs a server on different hardware and architecture.
- **§7.2 under a real server process** with sockets attached rather than a bare loop, and
  with tick and patch rates deliberately diverged.
- **§7.3 for a full room** — the table above is one player. 64 players correcting at once
  is the case that matters.
- **§7.4 client cost of 64 remote interpolated entities** — not started.
- **§7.5 on real extracted terrain** — the figures above use a synthetic grid, because
  `src/df2/Heightfield.ts` uses extensionless relative imports that Node will not resolve
  (`--experimental-specifier-resolution=node` is a no-op on Node 22) and fixing that is a
  terrain-spike change. Green Mile is rougher per cell than the synthetic field, so its
  saddle term will be larger; the tolerance above should be re-derived against it.
