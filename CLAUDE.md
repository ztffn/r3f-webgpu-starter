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

## Current state (July 2026)

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
- **Test build:** free-fly / on-foot camera with stances, instrument HUD, `netlify.toml`.
  Deploy with `npx netlify deploy --prod --dir=dist` from a machine that has prepared assets —
  or via a Git-connected build — prepared assets are committed, so both render the real map.
- **Open:** skirt artifact at eye height (`07-...md` §9), floating grass along ridgelines
  (same §), and scale calibration.
- **Next up (`01-...md` Phase 1.6):** human-test Green Mile, then runtime map switching.
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
