# Project orientation (read me first)

Browser reconstruction of **Delta Force 2** (NovaLogic, 1999) — specifically its Voxel
Space 32 heightfield terrain and the concealing tall grass that made prone-and-snipe work.
Hobby/reconstruction project, not commercial.

## Where the knowledge lives

`docs/` is the source of truth. Read in this order — but if you are about to **change code**,
read `08` first: it is the as-built spec and it names the traps that have already cost
sessions. `01`–`05` describe the target; `06`/`07` are ground truth and outrank everything.

`00` is the **why**, and it settles arguments the other docs cannot: when a decision is a
judgement call rather than a fact, the pillars decide it. Its test — *would a veteran DF2
player instinctively recognise this?* — applies to features, not to whether a shader compiles.

| Doc | What it settles |
|---|---|
| `00-core-design-thesis.md` | **Gameplay identity: 12 pillars + the "is this 1999 limitation or great design?" test.** The why behind everything below |
| `01-project-overview-and-roadmap.md` | Goals, non-goals, legal posture, **phased roadmap + current status** |
| `02-asset-format-specification.md` | PFF3, TGA, PCX, `.3DI` V8 byte layouts; **terrain format (confirmed)** |
| `03-terrain-and-grass-rendering-design.md` | Why grass is relief-mapped (dense-by-construction) + compute blades |
| `04-concealment-system-design.md` | `grassHeightField` line-of-sight / prone concealment |
| `05-engine-architecture-tech-stack.md` | Stack rationale, target module layout |
| `06-asset-extraction-findings.md` | **Ground truth from real extracted data** — trumps guesses elsewhere |
| `07-grass-visual-reference.md` | Grass measurement methodology, concealment results, **open artifacts** |
| `08-implementation-spec.md` | **As-built: module map, contracts, invariants, traps.** Read this before touching code |
| `10-fps-combat-implementation-spec.md` | **As-built FPS ownership, frame order, controls, performance, and deferred work** |
| `11-weapon-ballistics-and-modifier-system-spec.md` | **Trigger-to-impact contracts, formulas, budgets, and attachment/perk extension rules** |
| `12-character-motor-and-networking-spec.md` | **As-built shared character motor, room, transport and session test — and the traps that cost this subsystem the most time** |

## Current state (August 2026)

- **Stack:** Vite 8 + TypeScript (strict) + React 19 + R3F v9 + drei v10 + three 0.185
  `WebGPURenderer` with TSL shaders (auto WebGL2 fallback). Not CRA — that was removed.
- **Phase 1 done:** chunked/LOD terrain with skirts, analytic normals, TSL biome material,
  fog/water. Terrain **tiles infinitely** (camera-centred chunk window, geometry cached by
  wrapped index).
- **Phase 1.5 done:** renders the real extracted **EXP2-Green Mile** map when prepared assets
  are present in `public/assets/terrain/<slug>/`; falls back to synthetic fBm otherwise.
- **Phase 0 core done:** `tools/df2-extract` unpacks `.pff` archives, parses `.trn` manifests,
  decodes PCX and bakes the canopy field; validated against real archives.
- **Columnar grass, first pass:** per-fragment march writing its own depth. Still measurably
  flatter than the reference (`07-...md` §7).
- **Near-field blade layer:** 250k instanced blades over the march, placed from the world cell
  so the pattern is stationary; wind, player parting and a synthesised normal for sun.
- **Weather and atmosphere:** 18 presets (13 measured from the retro skyboxes, 5 from a CC0
  Kenney pack), one shared colour grade, distance fog + an absolute height SLAB that can lift
  into a band, analytic smoke volumes, and camera-local rain/snow. Distance haze fades to the
  **sky cubemap sampled along the view ray**, not to a constant — see `08-...md` §7.1.
  Networked, the **room owns its visuals** — weather and the 25 live dials ride one
  low-frequency `RoomState` packet and `?weather=` is ignored, because fog is concealment.
  Dials stay local offline and become **room-wide for an admin** (`DF2_ADMIN=1` on the
  server); the shared table is `src/df2/visualDials.ts`. `12-...md` §8.1-8.2 for the packet,
  why it is not Colyseus Schema, and the traps. Note `weather.ts` and `visualDials.ts` are
  now imported by Node, so they carry the no-Three-at-runtime rule (`12-...md` §3).
- **`atmosphere.ts` is the one call a scene material makes** — `shade(rgb, worldPos?)`, grade
  then fog. Read `08-...md` §8 invariant 7 before adding any material, and note it only works
  for UNLIT materials; lit props need the term after lighting and that variant does not exist.
- **Character motor and multiplayer spine:** a Rapier character motor that runs unchanged in
  the browser for prediction and in Node for authority, a room that owns the world step, a
  transport seam with a disposable WebSocket implementation, and a working two-client
  session. Walk it with **`?scene=motor`** (V shows the collider capsule). `src/motor/` and
  `src/net/` import **no Three.js and no React at runtime** — that is what makes them
  shared, and the Node tests enforce it. Read `12-...md` before touching either; its §6
  lists bugs that were each invisible until something was measured.
- **Multiplayer spine (Aug 2026):** shared fixed-tick character motor (`src/motor/`,
  Rapier) with client prediction/reconciliation (`src/net/GameClient.ts`), **Colyseus**
  rooms with the hot path on hand-packed binary (evidence:
  `docs/plans/2026-08-03-colyseus-transport-evaluation.md`), and an authoritative server
  simulating the real prepared terrain (`npm run game:server`, `tools/game-server/`).
  Play: `?scene=scope&motor=1&net=1`, two visible windows. Read `docs/12` first.
- **Character (Aug 2026):** animated soldier for remote players and the V third-person
  view (`src/fps/presentation/Character*`), aim rig driven by wire pitch, 49-clip
  Draco GLB in `public/assets/characters/`. Prone deliberately renders as the capsule
  (no prone clips baked yet). Combat/damage is still client-local — authority work is
  briefed in `docs/plans/2026-08-03-character-animation-session-handoff.md`.
- **Test build:** free-fly / on-foot camera with stances, instrument HUD, `netlify.toml`.
  Deploy with `npx netlify deploy --prod --dir=dist` from a machine that has prepared assets —
  or via a Git-connected build — prepared assets are committed, so both render the real map.
- **Open:** skirt artifact at eye height (`07-...md` §9), floating grass along ridgelines
  (same §), and scale calibration — calibrate scale BEFORE placing any authored asset, or
  every placement has to be redone.
- **Next up (combat authority):** server-authoritative damage, weather and world state —
  the worked brief is `docs/plans/2026-08-03-character-animation-session-handoff.md`.
  Also still queued (`01-...md` Phase 1.6): human-test Green Mile, then runtime map switching.
  Note that **the real grass data path has never been run** — Green Mile's strip is missing so
  it renders a stand-in canopy, but egypt / R66 / blizzard / vul001 ship their own strips and
  load as `grassSource: "real"` (`06-...md` §7). Preparing one of those is the cheapest way to
  exercise it.
- **Direction:** custom assets → player-created terrain → map/terrain editor tooling
  (`01-...md` Phase 6). Real assets are the dial-in instrument, not the deliverable.

## Key facts that are easy to get wrong

- **`_d.pcx` is the HEIGHTMAP** (`elev_map`), not a detail map. `_m.pcx` is the detail map.
- **Colormap is JPEG**, not TGA. Both colormap and heightmap are **1024×1024**.
- **Grass chain:** `detail_map[x,z]` (index 0–255) → `detail_elev` strip (64×16384 = 256
  tiles of 64×64) → that texel's grass **stretch height**. Bake this to `grassHeightField`;
  the renderer *and* the concealment query both read it (that shared field is the whole
  point — see `04-...md` §2).
- **Extract installers statically — never run them, no Wine/Whisky needed.** `innoextract`
  for Inno Setup wrappers, `unzip` for WinZip SFX. See `tools/df2-extract/README.md`.
- **Game assets ARE committed** — raw archives in `/assets/` (`EXP2.PFF`, 36 `.trn`, all
  extracted PCX/JPEG/TGA; see `assets/README.md`) and prepared output in
  `public/assets/terrain/<slug>/`. Community mod freeware authored by this project's own
  mod team, who hold the rights (`01-...md` §3),
  so the pipeline reproduces from source. The distinction that still holds: **retail**-extracted
  DF2 data is personal-use-only and never committed.
- Scale constants (`HEIGHT_SCALE`, `METERS_PER_TEXEL`) are **not yet calibrated** — they're
  placeholders in `src/df2/config.ts`.

## Commands

```sh
npm run dev        # Vite dev server :3000
npm run build      # tsc --noEmit + vite build -> /dist
npm run typecheck

node tools/df2-extract/df2extract.mjs list|extract|trn ...
```

## Conventions

- Author shaders in **TSL**, never raw WGSL/GLSL — one graph must serve both backends.
- Keep the CPU heightfield (`src/df2/Heightfield.ts`) **engine-agnostic and decoupled** from
  render geometry; it is the seed of the gameplay/concealment field.
- `src/df2/` is the Phase-1 spike; the target layout is `05-...md` §7
  (`/src/engine/{terrain,grass,concealment}`, `/src/game/`).

## Committing

Commit after each meaningful phase or task is complete — do not let a session accumulate a
large uncommitted working tree. Keep commits **atomic**: one logical concern per commit, and
split unrelated changes into separate commits.

Types:

- **New feature:** a new feature
- **Fix issue:** a bug fix
- **Other:** documentation, configuration, anything else

```
New feature: (#123) Add user authentication - implement JWT-based login system.
Fix issue: (#456) Fix memory leak in data processor - optimize buffer management.
Other: Update documentation for API endpoints.
```

**NEVER** add trailers: no "Generated with Claude Code", no author or co-author lines.

Note this does not override the global rule that git commands need explicit permission —
ask, then commit.
