# Project orientation (read me first)

Browser reconstruction of **Delta Force 2** (NovaLogic, 1999) — specifically its Voxel
Space 32 heightfield terrain and the concealing tall grass that made prone-and-snipe work.
Hobby/reconstruction project, not commercial.

## Where the knowledge lives

`docs/` is the source of truth. Read in this order:

| Doc | What it settles |
|---|---|
| `01-project-overview-and-roadmap.md` | Goals, non-goals, legal posture, **phased roadmap + current status** |
| `02-asset-format-specification.md` | PFF3, TGA, PCX, `.3DI` V8 byte layouts; **terrain format (confirmed)** |
| `03-terrain-and-grass-rendering-design.md` | Why grass is relief-mapped (dense-by-construction) + compute blades |
| `04-concealment-system-design.md` | `grassHeightField` line-of-sight / prone concealment |
| `05-engine-architecture-tech-stack.md` | Stack rationale, target module layout |
| `06-asset-extraction-findings.md` | **Ground truth from real extracted data** — trumps guesses elsewhere |

## Current state (July 2026)

- **Stack:** Vite 8 + TypeScript (strict) + React 19 + R3F v9 + drei v10 + three 0.185
  `WebGPURenderer` with TSL shaders (auto WebGL2 fallback). Not CRA — that was removed.
- **Phase 1 done:** chunked/LOD terrain with skirts, analytic normals, TSL biome material,
  fog/water/map-camera — running on **synthetic fBm** data (`src/df2/`).
- **Phase 0 core done:** `tools/df2-extract` unpacks `.pff` archives and parses `.trn`
  manifests; validated against real archives.
- **Next milestone (Phase 1.5):** swap synthetic fBm for a **real extracted DF-era map**
  (heightmap + colormap) to validate feel. See `01-...md` §6.

## Key facts that are easy to get wrong

- **`_d.pcx` is the HEIGHTMAP** (`elev_map`), not a detail map. `_m.pcx` is the detail map.
- **Colormap is JPEG**, not TGA. Both colormap and heightmap are **1024×1024**.
- **Grass chain:** `detail_map[x,z]` (index 0–255) → `detail_elev` strip (64×16384 = 256
  tiles of 64×64) → that texel's grass **stretch height**. Bake this to `grassHeightField`;
  the renderer *and* the concealment query both read it (that shared field is the whole
  point — see `04-...md` §2).
- **Extract installers statically — never run them, no Wine/Whisky needed.** `innoextract`
  for Inno Setup wrappers, `unzip` for WinZip SFX. See `tools/df2-extract/README.md`.
- **Never commit extracted assets** (NovaLogic + community authorship). `/assets/`, `*.pff`,
  `*.trn` are gitignored. Keep working copies outside the repo or in `/assets/`.
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
