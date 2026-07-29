# Delta Force 2 — Core Design Thesis

> **Goal:** Preserve the gameplay identity of Delta Force 2, not merely its graphics. Every design decision should answer:
>
> **"Was this a limitation of 1999 technology, or was it accidentally great game design?"**

The objective is not a museum-accurate remake, but a modern implementation that retains the original's behavioral DNA.

---

# Core Pillars

## 1. Scale
- Extremely large outdoor maps.
- Long sightlines (200–800m+).
- Terrain should feel geographical rather than arena-like.
- Players navigate landscapes, not corridors.

## 2. Terrain as Gameplay
- Terrain is primary cover.
- Hills, ridges, depressions and valleys create tactical decisions.
- The landscape itself drives combat.

## 3. Tall Grass
- Grass is concealment, not decoration.
- Enables crawling, observation and ambushes.
- Creates uncertainty and slows pacing naturally.

## 4. Prone Matters
- Going prone should dramatically reduce visibility.
- Height is a gameplay mechanic.
- Standing trades concealment for awareness.

## 5. Discovery Over Readability
- Players detect movement and silhouettes.
- Enemies should be found, not highlighted.
- Preserve uncertainty rather than perfect visual clarity.

## 6. Long-Range Combat
- Sniping and spotting are core gameplay loops.
- Engagements should begin long before players are close.
- Distance should fundamentally change tactics.

## 7. Low Time-To-Kill
- Positioning matters more than health pools.
- Every exposure is dangerous.
- Remove repetitive heal/re-engage loops.

## 8. Freedom of Approach
- Objectives instead of linear paths.
- Allow multiple infiltration routes.
- Reward reconnaissance and planning.

## 9. Atmosphere Through Space
- Large quiet areas are intentional.
- Solitude builds tension.
- Empty space is a feature, not wasted content.

## 10. Minimal UI
- Limited HUD.
- No outlines or excessive feedback.
- Let players interpret the battlefield.

## 11. Systemic Depth
- Complexity emerges from terrain, distance and visibility.
- Avoid unnecessary progression systems and attachment overload.
- Simple mechanics with rich interactions.

## 12. Community First
- Strong support for multiplayer.
- Modding and custom maps should be encouraged.
- Longevity comes from player-created content.

---

# Design Principles

## Preserve Behavior, Not Assets

Players remember how Delta Force 2 **felt**, not the polygon count.

The remake should preserve:

- scale
- concealment
- uncertainty
- freedom
- lethality
- atmosphere

rather than faithfully reproducing every visual limitation.

---

## Every Feature Must Pass This Test

> **Would a veteran Delta Force 2 player instinctively recognize this as Delta Force, even if they couldn't explain why?**

If the answer is yes, it belongs.

If it modernizes the game while preserving that feeling, it belongs even more.

---

# Technology Philosophy

Technology serves gameplay.

Whether terrain is rendered using:
- classic voxels
- triangle meshes
- clipmaps
- virtual geometry
- heightfields

is secondary.

The renderer should reproduce the gameplay characteristics that made DF2 unique:

- immense scale
- readable terrain
- long sightlines
- dense concealment
- smooth performance
- low visual noise

Players should remember **how it plays**, not how it is rendered.

---
---

# Appendix — how this lands in the current build

*Added by implementation, not part of the thesis above. The thesis is the standing document;
this appendix is a cross-reference and will drift — treat the thesis as authoritative and
delete this section freely if it stops being useful.*

The pillars are gameplay statements, but four of them already bind hard on decisions in the
code, and two more read as contradicted by the current build unless the reason is stated.

### Pillars that are already load-bearing

**Pillar 1 (Scale) and Pillar 6 (Long-Range Combat) make scale calibration a pillar-level
requirement, not a chore.** `HEIGHT_SCALE` and `METERS_PER_TEXEL` are still placeholders
(`08` §7), which means "long sightlines (200–800m+)" and "terrain should feel geographical"
are currently **unverified claims about a world whose size we have not established**. This is
why calibration sits at the top of the roadmap (`01` §6, Phase 1.5) ahead of more grass work.

**Pillar 3 (Tall Grass) and Pillar 4 (Prone Matters) are the same mechanic seen from two
sides,** and the architecture already encodes that: the renderer and the concealment query
read one shared `grassHeightField`, so what you see and what the game thinks you can see
cannot drift (`04` §2, `08` §8 invariant 3). "Standing trades concealment for awareness" is
measured, not aspirational — 525 px visible standing vs 0 px prone, at 50 m, even scoped
(`07` §8). Note the corollary the original had and we keep: **if you are concealed you are
also blind.** Prone showing only grass is correct behaviour, not a bug (`08` §11).

**Pillar 5 (Discovery Over Readability)** is the reason the grass-fade distances scale with
zoom rather than staying fixed: a fixed fade would dissolve grass into flat colour exactly
where a sniper is looking, handing the observer clarity the design says they should have to
earn (`08` §6.4).

### Design questions the thesis raised, and how they were settled

Adding this document surfaced three tensions between the pillars and the build. All three
were decided in July 2026; recorded here so they are not relitigated.

**Asset fidelity is a means, not an end — RESOLVED.** "Preserve Behavior, Not Assets" appeared
to contradict `01` §1's goal of using real DF2-era data. It does not: **real assets are the
dial-in instrument.** They are how we tell whether scale, terrain and concealment feel right,
because they are what players actually remember. The trajectory is toward custom assets,
player-created terrain and editor tooling (`01` §1, Phase 6). The load-bearing consequence:
**a missing original asset is never a project blocker** — authoring a plausible substitute
that delivers the behaviour is legitimate, provided it is labelled and never reported as
authentic.

**One hardcoded map — RESOLVED as sequencing, not architecture.** Pillar 12 wants custom maps;
the build pins `TERRAIN_SLUG` at compile time. Deliberate: Green Mile gets human-tested and
dialled in *first*, then a runtime loader for other real DF maps to cross-validate look/feel
(`01` Phase 1.6). That same path is what later loads player-made maps.

**Infinite tiling vs. "geographical, not arena-like" — RESOLVED as not a problem.** A 2048 m
tile repeating forever could in principle read as pattern rather than landscape. Accepted as
low-risk: if repetition ever becomes visible, **fog is the negotiating lever** — `FOG_NEAR` /
`FOG_FAR` (`08-...md` §7) bound how far a player can see a repeat, and modern fog is a far
better tool for this than 1999's. Do not spend effort pre-emptively defeating tiling.

### Two apparent contradictions, and why they are not

**Pillar 10 (Minimal UI) vs. the instrument HUD in the test build.** The HUD showing position,
AGL, frame time, draw calls and backend is a **development instrument, not the game's UI**.
Same for the shader's `debugHit` / `debugDistance` modes, which paint grass magenta — they
exist because eyeballing repeatedly passed builds that were measurably wrong (`08` §10). None
of it should survive into anything a player touches. Worth stating plainly so nobody
"preserves" it.

**Pillar 12 (Community First — strong support for multiplayer) vs. multiplayer being a stated
v1 non-goal.** Both are true and the distinction matters: multiplayer is **identity-critical**
(this pillar) and **deliberately out of v1 scope, on hold until the plan is laid out**
(`01` §2). The instruction that follows from holding both is already recorded: do not build
netcode, and do not foreclose it either — which is why `Heightfield.ts` imports nothing from
Three.js and can be sampled server-side (`08` §3). **Do not start on netcode from this pillar
alone.**

### What the Technology Philosophy licenses

"Whether terrain is rendered using classic voxels, triangle meshes, clipmaps, virtual geometry
or heightfields is secondary" is a genuine release of a constraint that `03` argues at length.
The current choice — rasterised chunked mesh for terrain, per-fragment columnar march for
grass — is justified on gameplay grounds (it integrates with polygonal objects, physics and
depth; a pure raycaster does not), **not** on authenticity grounds. If a future approach serves
the pillars better, this document says to take it.

The one thing that philosophy does *not* relax: the grass must still deliver **dense
concealment at 100% coverage that never thins with distance**, because Pillars 3, 4 and 6 all
rest on it. That is the property `07` §3's acceptance criteria exist to test — currently 3 of
6 met, with vertical coherence the outstanding gap.
