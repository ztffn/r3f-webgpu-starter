# Monetization, retention and server-cost brainstorm — Distant Front

**Date:** 2026-08-04
**Status:** brainstorm. Nothing here is decided and no code exists for any of it. The four
revenue directions are options, the cost model is arithmetic over measured numbers plus
labelled estimates, and the retention mechanics are candidates. The hard boundary is §6 of
`2026-08-04-web-platform-and-ui-design.md` (reinforced by `00-...md` pillars 9–11): nothing
purchasable may affect concealment, ballistics or visibility, and medals/career are earned
from play, never bought.

**Scope guardrails:** this document proposes product and pricing; it proposes no combat or
concealment change. Every revenue idea here is status, access, community or compute — never a
combat capability.

---

## 1. The question this document answers

Distant Front will have a real server bill (the Colyseus room host) and a real client bill
(static assets via CDN). The supporter tier exists (`src/account/tiers.ts`) but its price
and perks were shaped before the costs they must cover were measured. This document:

1. Builds a per-player-hour and per-concurrent-player cost model from **measured** wire and
   CPU numbers.
2. Costs three occupancy scenarios on three hosting routes.
3. Computes the break-even supporter count.
4. Develops four revenue directions that respect the fair-play line.
5. Proposes retention mechanics that use existing infrastructure.
6. Names the mechanics rejected from the NOVA prior art and why.

## 2. Measured inputs — the cost model's foundation

These are the numbers this document's arithmetic stands on. Nothing below is guessed; the
two estimates in the tables are marked.

### 2.1 Wire cost (measured)

The transport evaluation (`plans/2026-08-03-colyseus-transport-evaluation.md`) and the
motor measurements record (`plans/2026-08-02-motor-measurements.md`) agree on the codec:

| Fact | Value | Source |
| --- | --- | --- |
| Downstream packet, hand-packed | 27 B/player + ~10 B framing | `12-...md` §8; largest 64-player packet = 1,738 B |
| Patch rate | 20 Hz | `tools/game-server/server.ts` |
| Upstream command | 10 B at 60 Hz | `12-...md` §8 |
| Full-room per-client downlink | ~35 KB/s (64 players) | 27 × 64 × 20 = 34.6 KB/s |

**The per-player cost scales with room population** — every client receives a snapshot of
the whole room, so a full room costs far more per player-hour than a small one. This is the
single most important fact for the cost model, and the reason break-even cannot be quoted as
one number.

| Room population N | Per-client rate | Room egress | Egress per player-hour |
| ---: | ---: | ---: | ---: |
| 6 | 3.4 KB/s | 20.6 KB/s | **~12 MB** |
| 32 | 17.5 KB/s | 560 KB/s | **~63 MB** |
| 64 | 35 KB/s | 2.2 MB/s | **~125 MB** |

Plus ~2.2 MB/player-hour upstream in all cases (600 B/s × 3600). At full occupancy a room
burns **~8 GB/hour of egress**, dominated by the largest clients' snapshots.

### 2.2 CPU cost (measured — corrected)

The handover's earlier "2 ms/tick" was the **bare-loop** figure (`motor-measurements.md`:
2.09 ms at 64 players). With real sockets attached, the transport evaluation measures higher
and that is the number that governs:

| Players | Wall ms/tick (mean) | Share of 16.67 ms budget |
| ---: | ---: | ---: |
| 16 | 2.33 | 14% |
| 32 | 3.29 | 20% |
| 64 | 4.40 | **26%** |

So one 64-player room occupies roughly a quarter of one core. Realistically **2–3 full rooms
per vCPU**, not 2–4 — and see §2.3 for why headroom is a safety margin, not spare capacity.

### 2.3 The amplifier that forbids running hot

The transport evaluation §4.2 documents an **unrecoverable catch-up amplification spiral**:
one stall long enough to push all peers past the buffer-depth threshold makes every later
tick run one room step per backed-up peer — at 64 players, 65 × 2.1 ms ≈ 137 ms per tick,
measured exactly, at which point the queues pin and discard input forever. A single ~200 ms
GC pause in production could trigger it. Consequence for sizing: **never run a room above
~50% of a core's budget** so a GC spike has room to drain before the spiral engages. The
fix direction (global catch-up budget per tick) is already recorded as deferred work in
`12-...md` §11; the cost model below assumes it lands before any paid hosting does.

### 2.4 Memory per room (estimate — unmeasured)

Room memory was never measured. Composition is known: Node runtime (~50–80 MB), Rapier WASM,
the 4 MB shared terrain lattice at `DEFAULT_SUBDIVISION = 2` (`motor-measurements.md` §7.5),
64 player states plus snapshot buffers. A **200–500 MB working set per busy room** is the
estimate used below; it is unmeasured and flagged as such. Colyseus Cloud's 1 GB tier is
therefore treated as one-room-only regardless of CPU.

### 2.5 Client delivery (measured)

`public/assets/` (the prepared, client-served terrain and character data) is **25 MB**;
the built `dist/` is **69 MB**. Every full client download is ~69 MB of CDN egress per new
or cache-missed session. Small against room egress at scale, but it is the dominant egress
cost *today* (nobody is playing yet), so it is not ignored below.

## 3. Occupancy scenarios

Three honest scenarios, chosen to bracket "friendly hobby project" to "small game that needs
to pay for itself". Player-hours and egress are derived from §2; the room-fill assumptions
are the estimates here.

### A — The current reality, scaled a little

1–2 rooms, ~6 players average, three evenings a week, ~3 h each.

| | Value |
| ---: | ---: |
| Player-hours / month | ~500 |
| Egress / month | ~6 GB |
| Peak concurrent | ~12 |
| Rooms needed | 1 |
| Cost (Hetzner) | ~$4.50/mo flat |

### B — A game that is working

One busy 64-player room, 4 h/day full + 4 h/day at half population.

| | Value |
| ---: | ---: |
| Player-hours / month | ~11.5k (full 120 h × 64 + half 120 h × 32) |
| Egress / month | ~1.2 TB (960 GB full + 240 GB half; the earlier "1.4 TB" figure was the coarse estimate, this is the recomputed one) |
| Peak concurrent | ~64 |
| Rooms needed | 1–2 |
| Cost (Hetzner) | ~$4.50/mo flat (20 TB included) |

### C — Three times B

~34.5k player-hours, ~3.6 TB egress, peak ~192 concurrent, 3 busy rooms. Still within one
Hetzner CX32's 20 TB egress allowance.

## 4. Hosting routes — live pricing (fetched 2026-08-03)

| Route | Compute | Egress | Notes |
| --- | --- | --- | --- |
| **Hetzner** CX22 | ~$4.50/mo (2 vCPU, 4 GB) | **20 TB included** | CX32 ~€8–10/mo (4 vCPU). The egress allowance swallows scenarios A–C entire. |
| **Colyseus Cloud** vc2-1c-1gb | $12.50/mo | unlimited, no CCU limits | 1 GB → one room (§2.4). vhf-1c-2gb $36/mo for a busy room. |
| **Fly.io** | ~$5.70/mo compute + ~$2/mo IPv4 | $0.02/GB after 100 GB free | Metered pay-as-you-go. Everything you run, you meter. |

## 5. Monthly cost and break-even per scenario

### 5.1 Monthly cost

| Scenario | Hetzner | Colyseus Cloud | Fly.io |
| --- | ---: | ---: | ---: |
| A (~500 player-hrs) | ~$4.50 | ~$12.50 | ~$8 (100 GB free covers egress) |
| B (~11.5k player-hrs) | ~$4.50 | ~$36 | ~$32 (1,100 GB over × $0.02 + compute + IP) |
| C (~34.5k player-hrs) | ~$10 | ~$108 (3 rooms) | ~$96 (3.5 TB over + compute + IP) |

### 5.2 Per player-hour

| Scenario | Hetzner | Colyseus Cloud | Fly.io |
| --- | ---: | ---: | ---: |
| A | $0.009 | $0.025 | $0.016 |
| B | $0.0004 | $0.003 | $0.003 |
| C | $0.0003 | $0.003 | $0.003 |

The shape is the story: **a fixed-cost host (Hetzner) with included egress makes the game
cheaper the more it is played; metered hosts (Fly, Colyseus Cloud) charge per play and the
per-player-hour cost floors at ~$0.003.** Hetzner is ~10× cheaper at scale and gets *more*
efficient with usage.

### 5.3 Break-even supporters per 100 MAU

At a **$5/mo** supporter price and an assumed **~10 player-hours per MAU** (validated against
gaming-app DAU/MAU benchmarks of 20–30% and session-based play — see §8.1), break-even per
100 MAU = `(monthly cost ÷ 5) × (100 ÷ MAU)`:

| Scenario (≈ MAU) | Hetzner | Colyseus Cloud | Fly.io |
| --- | ---: | ---: | ---: |
| A (~50 MAU) | ~1.8 | ~5.0 | ~3.2 |
| B (~1,150 MAU) | ~0.08 | ~0.63 | ~0.56 |
| C (~3,450 MAU) | ~0.06 | ~0.63 | ~0.56 |

**Headline:** on the cheap host the game breaks even at **well under one supporter per 100
monthly players** once it reaches a few hundred players. On metered hosts the honest planning
number is **0.6–0.7 supporters per 100 MAU**. The earlier "1–2 per 100" was a conservative
placeholder; the measured-cost version is lower, but only if the room host stays a flat-rate
VPS and the amplifier fix (§2.3) lands.

**The same number at F2P conversion rates:** industry free-to-play conversion is 2–5%
(games specifically; competitive titles at the top of that band). At 2% of MAU becoming
supporters, a 1,000-MAU game has ~20 supporters = $100/mo. That is 20–50× the Hetzner bill
and 3× even the Colyseus Cloud bill. **Even a mediocre conversion rate on a small audience
covers the fixed-cost host several times over.** The constraint on this project is never
going to be server cost at hobby scale; it is audience, and that is a retention problem, not
a pricing one.

## 6. What the numbers say about pricing

1. **The $5/mo flat tier can't honestly promise compute.** "Your money hosts the servers" is
   a promise the flat tier breaks the moment usage scales past one VPS. On Hetzner, compute
   is ~$0.06–0.08 per 100 MAU — supporters are buying a *club*, not a server. The tier should
   sell status/access and stop promising to pay for compute.
2. **Compute that *does* scale with egress belongs in a separate product.** Community-hosted
   servers are the only revenue line that genuinely tracks marginal cost. Charge for them at
   marginal cost (see direction 2 below), and keep the flat tier honest.
3. **The metered-hosting trap is avoidable.** At the moment the game costs more than a VPS,
   it is already large enough that Fly/Colyseus's $0.003/player-hour starts mattering —
   but by then the game is big enough that the decision is strategic, not financial. Do not
   start metered.
4. **Early maps as a supporter perk has a pricing wrinkle.** `earlyAccessMaps` is the only
   capability that could be read as content-gating. It is an *early* window, not exclusivity,
   and the supporter page must say so or the "nothing purchased affects the game" line
   erodes.

## 7. Four revenue directions (the actual options)

All four survive the fair-play test. They are ordered roughly by how much they fit the
existing product today.

### Direction 1 — Keep the flat Supporter tier, reframe it as status and access

$5/mo, unchanged perks (clans, insignia, marker, private-game hosting, reserved slot), with
**two corrections**:

- Drop any "keeps the servers running" framing; replace with what the tier actually buys:
  *run part of this community*.
- Make `earlyAccessMaps` explicitly a timed window, written on the supporter page.

Fits today: the tier table, gates and supporter page already exist. This is the cheapest
direction to ship and the one the FAQ already promises in writing.

### Direction 2 — Cost-tied Clan / Community Host product

The one revenue line that scales with the true cost driver (egress). Self-hosting stays free
(anyone with a machine runs their own room — the architecture already allows it). Project-hosted
persistent community servers are charged at **marginal cost** (~$10–20/mo on Hetzner), so it
can never be accused of profiteering, and it is the only line whose price *must* track real
usage.

This is the NOVA affiliate-network idea (server rental as community moat) repurposed without
its affiliate cut: the project is the host, the community runs the games, and the price is
the machine.

### Direction 3 — One-time Patron / Founder tier and a plain tip jar

A $30–50 one-time "founder" grant (permanent supporter marker variant, name in a credits
list) plus a donation line with no benefits. Low-volume, high-trust, zero urgency. Useful as a
launch signal and as a capstone for the community-built direction.

### Direction 4 — Retention as the growth lever (not a fourth revenue line)

No new revenue; the highest-leverage work. Career-as-record and medals-as-moments already
exist in the schema and are completely unused — `recordSession` writes matches and seconds,
`recordLongestShot` is tested with no caller, and the `medals` table is empty. The first
retention feature is to *ship the career the accounts already record*: kills/deaths once
feat/server-ballistics lands, then medals. Squads and clan squad-nights on the existing
private-game infrastructure give the community a weekly cadence. Explicitly rejected (pillar
11 and §6): XP bars, levels, daily-login streaks, and anything that rewards session count.

## 8. Retention mechanics and their evidence

### 8.1 The audience maths that justifies retention-first

Industry benchmarks gathered 2026-08-04:

| Benchmark | Value | Source |
| --- | ---: | ---: |
| Gaming-app DAU/MAU | 20–30% | Adapty, CleverTap, FeatureVote (2026) |
| DAU/MAU 20% ≈ | 6 active days/month per user | Adapty glossary |
| F2P free→paid conversion | 2–5% (competitive MP to 5–8%) | generalistprogrammer.com (2026) |
| Session-based shooter play | 30–60 min typical | general game engagement data |

The bridged assumption **~10 player-hrs/MAU** (2 sessions of ~45 min on 6–7 active days) sits
inside the gaming band; it is an estimate and the model in §5.3 tolerates halving it before
any scenario stops breaking even on Hetzner.

### 8.2 Candidate mechanics, cheapest first

1. **Career is live (do this first).** Wire real kills/deaths (waiting on
   feat/server-ballistics), make `recordLongestShot` have a caller, populate the empty
   leaderboards. The server already records matches and seconds — the profile just never
   fills.
2. **Medals as earned moments.** The `medals` table exists; write real award rules
   (`src/account/medals.ts` is the catalogue and the only award rule). Award on `onLeave`
   from the *stored* career, never grant — the earned-not-bought line is the product.
3. **Clan squad-nights.** `foundClan` is an ungranted supporter capability; private games by
   code already work. A scheduled weekly event on the existing private-room path is the
   cheapest community cadence that exists.
4. **Community-hosted servers as the social hub.** Phase 6b's `hostCommunityServer` is the
   only capability that turns players into hosts. The lobby already renders `community` and
   `hostCallsign` — nothing sets them yet.

### 8.3 Rejected, with reasons

From the NOVA prior art (`~/Documents/.../Novacorp_modshop.pdf`) and industry practice, and
rejected against the pillars and §6:

| Mechanic | Why rejected |
| --- | --- |
| Faux currency masking real money | Pillars: dishonest pricing is a brand-death risk for a trust-led project; the FAQ and supporter page promise transparency in writing |
| Randomised rewards / loot boxes | Non-combat versions are still gambling-adjacent; adds compliance surface for no retention gain |
| Purchase-shortened medals / paid progression | Directly breaks "earned, not bought" — the entire fair-play architecture |
| XP / levels / daily streaks / session-count rewards | Pillar 11 explicitly rejects session-count reward mechanics; it manufactures addiction, not community |
| DDA to maximise spend (dynamic difficulty aimed at wallets) | The opposite of "easy to play, better to register"; hostile to the reconstruction's audience |
| Purchase-framing / artificial urgency / countdown offers | Dark-pattern family; §6's posture is community-building, not conversion-pressure |
| Skin/micro-transaction gambling / RMT | Nothing bought may affect visibility — the only cosmetics with value in a sniper game are the ones §6 forbids selling |

The **NOVA mechanics that are worth keeping** (they are status/community, not spend-hacking):
SAPS reinforcement ordering (status → access → power → stuff, applied as *status and access
only*), the affiliate-style server-rental community network (→ Direction 2), community-as-moat
(reasoning that the social graph is the defensible asset), and Bartle-type segmentation as a
way to describe *which players build the community*, never to target spenders.

## 9. What remains unmeasured — the honest list

These are the numbers this document had to estimate, and each one is flagged in the tables
where it lands:

1. **Memory per busy room (200–500 MB)** — never measured. Sizes Colyseus Cloud's tier choice.
2. **Client GPU cost on mobile** — the grass march and 250k blades are unprofiled on mobile
   GPUs (§2.5 of the design record, open phase-6 measurement). Bounds the touch audience,
   which bounds MAU assumptions.
3. **Room-fill behaviour (6 avg / 64 full) and hours-per-community-member** — the occupancy
   scenarios are designed, not observed; the game has not had a real community.
4. **~10 player-hrs/MAU** — bridged from gaming benchmarks; the break-even survives halving it
   on Hetzner, so the conclusion is robust to it.
5. **x86 server CPU vs Apple Silicon** — the 4.4 ms/tick measurement is from Apple Silicon;
   the transport evaluation itself flags cross-platform divergence as open. Hetzner runs x86.
6. **The amplifier fix has not landed** — scenario B/C pricing assumes it does before paid
   hosting.
7. **Actual supporter conversion** — industry 2–5% is the prior; this game's audience (retro
   DF2 veterans) is older and more donation-inclined than a mobile average, which argues
   higher, but that is a hypothesis.

## 10. Recommendation

1. **Host on Hetzner** (or any flat-rate VPS with generous included egress), not Fly or
   Colyseus Cloud, for as long as the game fits one box. The egress allowance covers
   scenarios A–C, and the fixed cost is what makes the whole model work.
2. **Keep the $5/mo Supporter tier, reframe its pitch away from "hosting the servers" and
   toward status/access**, and make the early-map perk explicitly a timed window.
3. **Add the cost-tied community-server product as the only egress-scaling revenue line**,
   priced at marginal cost.
4. **Spend the real effort on retention, not pricing**: the cheapest, highest-leverage work
   in the entire document is wiring the career that `recordSession` already records — the
   numbers say the project's constraint is audience, and the audience constraint is a
   retention problem.
5. **Land the catch-up amplifier fix (§2.3) before any paid room hosting**, and re-measure
   memory per room then.

None of this changes the fair-play line. The cheapest thing in this document (career wiring)
and the most expensive (community server rental) are both outside it.
