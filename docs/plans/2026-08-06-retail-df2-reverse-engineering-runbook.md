# Retail DF2 reverse-engineering runbook

Purpose: the working plan for mining the retail Steam DF2 install (running in Parallels,
copied to `_tempAssets/df2_original/`) for format knowledge, calibration constants and
ground-truth measurements. Scope: inventory, format status, prioritized workstreams, method
rules and the tooling to build. Knowledge lands in `docs/02`/`docs/06`; retail bytes never
leave `_tempAssets/`. Companion reference: taylorfinnell/opennova (Godot reimplementation
of the JO-era engine) and its wiki of NovaLogic format pages.

## 0. Legal and hygiene rules (non-negotiable)

1. **Retail-extracted data is personal-use-only** (`docs/01` §3). It lives under
   `_tempAssets/` — verified gitignored (`.gitignore:152`) — and never enters `assets/`,
   `public/`, any commit, or any deploy. The committed pipeline stays reproducible from the
   community freeware archives alone.
2. **What we take from retail is knowledge, not bytes**: byte layouts, field semantics,
   constants, and measurements. Those go to `docs/02` (format spec) and `docs/06` (ground
   truth), each with the probe command that produced it.
3. **opennova is read-only reference.** The repo shows no license file — treat the code as
   all-rights-reserved: read it to understand formats, cross-check the wiki, but do not copy
   code into our tools. Independent reimplementation from the documented layouts is fine.
4. Never run retail installers or patchers from macOS. The game already runs in Parallels;
   the running game is an *instrument*, not something to automate blindly.

## 1. What we have (measured 2026-08-06)

Install copy: `_tempAssets/df2_original/Delta Force 2/` (679 MB).
Both archives extracted with the existing tool — **no unpacking work was needed, retail
PFFs are plain PFF3 and `df2extract.mjs` handles them as-is**:

```sh
node tools/df2-extract/df2extract.mjs extract "_tempAssets/df2_original/Delta Force 2/Df2.pff"      _tempAssets/df2_original/extracted/df2main   # 890 files
node tools/df2-extract/df2extract.mjs extract "_tempAssets/df2_original/Delta Force 2/Terrains.pff" _tempAssets/df2_original/extracted/terrains  # 792 files
```

### 1.1 Install root (beyond the two PFFs)

| File | What it is | Why it matters |
|---|---|---|
| `Df2.exe` (1.27 MB), `Hw_d3d.dll` | the engine + D3D renderer | static analysis target: scale/fog/speed constants (W1, W8) |
| `Pack.exe` (73 KB) | NovaLogic's own PFF packer | oracle for a future PFF *writer*; also a tiny RE target |
| `Cmprssh0.dll` (28 KB) | compression DLL | prime suspect for the SCR container codec (W7) |
| `Df2music.sbf` (14.5 MB) | `SBF0` music segment bank (`beat101`, `beat102`, …) | W6 |
| `Example.mis` | **plain-text mission file**, CRLF, `begin general_information … terrain dfdg1.trn … water_level 20 … weather_type 0` | Rosetta stone for the mission grammar (W4) |
| `DF2MAN.PDF`, `DF2STRAT.PDF`, `DF2MED.PDF` | manual, strategy guide, mission-editor manual | searchable behavior documentation — weapon data, map notes, editor semantics |
| `CustomTools/df2c4med/` | community C4-engine MED adapted for DF2, with `MED.PFF`, `C4MED.PDF`, conversion scripts | a working editor for the formats we're decoding |
| `CustomTools/FwOBMS2MISConverter/` | **BMS→MIS converter** (VB6 installer) | turns the 92 binary missions into readable text (W4) |
| `DF2INTRO.BIK` | Bink video | ignore |

### 1.2 Archive census

`Df2.pff` — 890 records — the *game* layer:

| Ext | n | Identified as |
|---|---|---|
| WAV | 419 | sounds (weapons, foley, ambience) |
| PCX | 205 | UI art, textures |
| BMS | 92 | binary missions — magic `BMS\x0f`, then mission name + designer in cleartext |
| TGA | 88 | textures |
| JPG | 24 | UI art |
| 3DI | 19 | models (weapons/hands?) |
| BIN | 14 | unknown small binaries (`DFDLGCS.BIN` pairs with the DBFs) |
| ANM | 12 | **SCR-container**, high-entropy body — locked (W7) |
| PWF | 5 | `PWF2` audio banks — `DF2.PWF` ~37 MB, entries like `BODY1` (voice/dialog) |
| DBF | 4 | `DLG0` dialog databases (`DFDLGCO/CS/KW/SM` = the four campaigns) |
| DEF | 3 | **SCR-container** (not text) — locked (W7) |
| KSA | 2 | `KSA\0` v1 — skeletal animation (`PLAYER01`, `2PLAYR01`) |
| TRN/SCR/MNU | 1 each | terrain manifest; bare SCR blob; menu definition |

`Terrains.pff` — 792 records — the *world* layer:

| Ext | n | Identified as |
|---|---|---|
| 3DI | 625 | world props: buildings, vehicles, foliage, effects |
| PCX | 64 | per-map `_D` heightmaps, `_M` detail maps, `_DM` detail-elev strips, skies |
| TGA | 48 | `_CM` detail-color strips + textures |
| TRN | 18 | the 18 retail maps |
| JPG | 18 | `_C` colormaps |
| CAL | 18 | per-map surface-class tables (see below) |

### 1.3 The 18 retail terrains — complete data sets

Maps: `DFD1 DFD2 DFDG1 DFDG2 DFDS1 DFG1 DFG2 DFG3 DFG4 DFG5 DFGS1 DFS1 DMD3 DMDG3
DMDS2 DMG6 DMGS2 DMS2`. (Naming hypothesis, unverified: `DF`/`DM` = campaign/multiplayer,
`G`/`D`/`S` = green/desert/snow biome codes.)

Every map ships the **full seven-file set** — including the detail strips Green Mile lacks:

- `<map>.TRN` — parses cleanly with our existing `trn` command (verified on `DFG1.TRN`:
  "Green One" by Jason Tull, `sky_height 1236`, `water_height 35`, filter/gamma/saturation).
- `<map>_C.JPG` colormap, `<map>_D.PCX` heightmap, `<map>_M.PCX` detail map — the known trio.
- `<map>_DM.PCX` **detail-elev strip** (grass stretch heights) and `<map>_CM.TGA`
  **detail-color strip** — the TGA is exactly 18 + 64×16384×4 bytes (uncompressed 32-bit),
  confirming the 256-tiles-of-64×64 layout from `docs/02` §5.
- `<map>_CM.CAL` — **newly identified, trivial format**: plain text, one `class,param` row
  per detail tile (256 rows + terminator; DFG1: 82×`Gs2`, 71×`Dt2`, 39×`Rk2`, 38×`Gs3`,
  14×`null`, 12×`ct1` with params 10/40). The TRN's until-now-opaque `char_data` field names
  this file. Hypothesis: per-tile surface *character* — grass/dirt/rock classes → footstep
  sounds, hit effects, possibly concealment semantics. (W3)

## 2. Format status board

| Format | Status | Next action |
|---|---|---|
| PFF3 | **done** — extractor verified on retail | none |
| TRN | **done** — parser verified on retail; `char_data`→CAL semantics new | record in `docs/02` |
| PCX/TGA/JPEG | done (Phase 0) | none |
| CAL | **cracked today** (text) | tiny parser + semantics validation (W3) |
| MIS | text, self-describing | grammar doc + Node reader (W4) |
| BMS | header understood; body unknown | shipped converter as oracle + opennova wiki `BMS` page (W4) |
| 3DI | V8 layout in `docs/02`; 644 retail samples | batch-validate the spec, build inspector (W5) |
| SBF (`SBF0`) | entry table visible in header | lister + WAV export (W6) |
| PWF (`PWF2`) | magic + entry names visible | lister (W6) |
| WAV | assumed standard RIFF | census, spot-check (W6) |
| DBF (`DLG0`) | dialog DB, low priority | defer |
| KSA | magic + version visible | defer until character work needs it |
| ANM / DEF / SCR / MNU | **locked** — SCR obfuscated/compressed container | W7; opennova wiki has an `SCR` page; `Cmprssh0.dll` is the suspect codec |

## 3. Workstreams, prioritized

Ordered by project need, not by curiosity. W1 blocks authored-asset placement
(`CLAUDE.md` open item); W2–W3 feed the grass/concealment pillars; the rest unlock in order
of gameplay value.

### W1 — Scale calibration (the blocking one)

**Goal:** replace the placeholder `HEIGHT_SCALE` / `METERS_PER_TEXEL` in `src/df2/config.ts`
with measured values.
**Method:** triangulate three independent sources until two agree:
  (a) *In-game measurement* — run the retail game in Parallels on a known map (DFG1),
  use known-size objects and the map's own water line; pace off distances with the
  strategy-guide maps; compare against our renderer loading the same retail terrain locally.
  (b) *Executable constants* — Ghidra over `Df2.exe`: the heightmap→world transform and the
  fog/view-distance constants live somewhere near the terrain sampler.
  (c) *Geometry cross-check* — a human-scale 3DI prop (door height, vehicle length vs the
  real M2 Bradley/UH-60 dimensions) placed on the heightfield fixes meters-per-texel.
**Deliverable:** calibrated constants + method note in `docs/06`. **Done when:** two of the
three methods agree within ~5 %.

### W2 — Side-by-side terrain fidelity (retail as dial-in instrument)

**Goal:** our renderer showing a retail map next to the real game showing the same map —
the measuring setup `docs/07` §methodology wants for grass height, draw distance, fog and
the two open artifacts (skirt at eye height, ridgeline floating grass).
**Method:** prepare one retail map (DFG1) through the existing prepare pipeline into a
**gitignored** local terrain dir (NOT `public/assets/terrain/` — that path is committed);
load it with the existing `?map=` machinery; screenshot both sides at matched positions.
Note: exercising `grassSource:"real"` for the *committed* pipeline still goes through the
freeware egypt/R66/blizzard/vul001 strips (`docs/06` §7) — retail adds 18 more strips and,
uniquely, the ability to compare against the original renderer live.
**Deliverable:** measured deltas in `docs/07`. **Done when:** grass height/density and fog
curves are quantified against the original, not eyeballed.

### W3 — CAL semantics → surface & concealment truth

**Goal:** confirm what `class,param` per detail tile drives.
**Method:** decode `DFG1_M.PCX` (detail map indices) + `DFG1_DM.PCX` strip + `DFG1_CM.CAL`
together; render a false-color overlay of classes on the colormap; sanity-check that `Gs*`
tiles sit where the colormap is green and `Rk*` where it's rock. In-game: walk those tiles
and listen — footstep sets should switch with the class. Check `ct1,40`-style params against
anything visibly special (roads? craters?).
**Deliverable:** CAL section in `docs/02`; note in `docs/04` if classes turn out to carry
concealment meaning. **Done when:** every DFG1 class is mapped to an observed behavior.

### W4 — Missions: MIS grammar + BMS bodies

**Goal:** read all 92 retail missions as data.
**Method:** write the MIS text reader from `Example.mis` (self-describing); run the shipped
`FwOBMS2MISConverter` in Parallels over a few BMS files to get text/binary pairs, then write
the Node BMS reader against those pairs, cross-checking the opennova wiki `BMS` page
(JO-era — expect version skew; our magic is `BMS\x0f`).
**Payoff:** per-mission environment (`water_level`, `fog_level`, `weather_type` — maps
straight onto our room-owned weather state), item placements for prop layout after W1, and
mission structure for the eventual campaign feel. **Done when:** all 92 parse and dump to
JSON.

### W5 — 3DI model corpus

**Goal:** validate the `docs/02` .3DI V8 layout against 644 retail samples and get one
building on screen (locally).
**Method:** batch header scan first (version histogram, size sanity) — the spec was written
from far fewer samples; expect surprises. Then a Node inspector that dumps mesh counts,
texture refs, bounds; then a one-off glTF conversion of a landmark building for the W2
side-by-side. Cross-references, in order: `Acruid/NovalogicTools` `File3di.cs` (DF2-specific,
the source `docs/02` was ported from), then opennova's `Model/` code (JO-era).
**Done when:** the batch scan passes on all 644 or the spec is amended where it fails.

### W6 — Audio banks

**Goal:** weapon/foley WAV census (419 files — the ballistics feedback layer will want
these as *reference*, recreated not copied), SBF0 and PWF2 bank layouts.
**Method:** entry tables are visibly simple (name + offset + size in the headers we dumped);
write listers, export a few entries, verify they play. **Done when:** listers cover both
bank formats and the WAV census is in `docs/06`.

### W7 — The SCR container (unlocks ANM, DEF, MNU, SCR)

**Goal:** open the obfuscated `SCR`-prefixed container.
**Method:** opennova wiki `SCR` page first (it exists for JO — check applicability);
entropy profile of the 12 ANM bodies (compressed vs encrypted look different); then
`Cmprssh0.dll` in Ghidra — 28 KB, likely one codec, exported functions will say. The MED
`.scr` conversion scripts in `CustomTools` are *text*, so the extension is overloaded —
don't conflate them.
**Done when:** one ANM decodes to something structured.

### W8 — Executable constants (ongoing background)

**Goal:** the numbers the docs call "1999 limitation or great design": fog curve, view
distance, grass draw distance, stance speeds, weapon sway/spread tables.
**Method:** Ghidra project over `Df2.exe` + `Hw_d3d.dll`, driven by *questions from other
workstreams*, not open-ended spelunking. String refs from the config/console names are the
entry points. **Done when:** it answers W1 and the ballistics-tuning questions on the
`feat/server-ballistics` branch.

## 4. Method rules (learned the hard way — `plans/…web-platform…` §5.7)

1. **Measure, don't reason.** Every claim in this runbook marked *hypothesis* stays out of
   `docs/02`/`docs/06` until a probe confirms it. The review history shows plausible
   reasoning being wrong (the 40/100 patience score, the 200-vs-550 median).
2. **Findings land with their probe command**, so any session can re-derive them.
3. **Probes are Node built-ins only**, in `tools/df2-extract` style; throwaway analysis can
   live in the scratchpad, anything worth keeping becomes a `df2extract.mjs` subcommand.
4. **Cross-validate against the community EXP2 data** whenever a format exists on both
   sides — retail-vs-freeware differences are themselves findings (and freeware findings
   are the only ones the committed pipeline may depend on).
5. **JO-era references (opennova) are leads, not truth** — DF2 is two engine generations
   earlier; verify every field against DF2 bytes before writing it into `docs/02`.

## 5. Tooling to build (all small, all Node)

| Tool | For | Size |
|---|---|---|
| `df2extract.mjs cal <file>` | CAL → JSON | trivial |
| `df2extract.mjs mis <file>` | MIS → JSON | small |
| `df2extract.mjs bms <file>` | BMS → JSON (after W4 oracle pairs) | medium |
| `df2extract.mjs 3di <file>` | header/mesh inspector | medium |
| `df2extract.mjs sbf/pwf <file>` | bank listers + entry export | small |
| strip/CAL false-color PNG dump | W2/W3 visual checks | small |

## 6. External references

- **NovalogicTools** — https://github.com/Acruid/NovalogicTools — **the primary one for
  DF2**: C# mod tools specifically for DF2, and the source `docs/02`'s byte layouts were
  ported from (`PffArchive.cs`, `TgaConvert.cs`, `PcxConvert.cs`, `File3di.cs` — PFF3 and
  the full .3DI V8 layout). `tools/df2-extract` is the Node port of its PFF side; its
  `File3di.cs` is the first cross-reference for W5 before touching opennova's JO-era code.
  The URL fell out of `docs/02` in the 77c9ffe doc rewrite (the name stayed) — keep it here.
- **opennova** — https://github.com/taylorfinnell/opennova (the `opennova-net` move
  mentioned in the README 404s as of today; the original repo + wiki are live). Wiki pages
  relevant to us: `PFF`, `TRN`, `3DI`, `BAD`, `BMS`, `SCR`, plus `CPT`/`TIL`/`STRP` for
  terrain-adjacent structures. C# parsers under `Definition/`/`DefinitionsParsers/`.
  License: none visible → read, don't copy (§0.3).
- **Shipped PDFs** (`DF2MAN`, `DF2STRAT`, `DF2MED`, `C4MED`) — searchable behavior spec;
  strategy guide likely has weapon tables and map walkthroughs.
- **The running game in Parallels** — the only instrument that answers "what did it
  actually look/feel like" (`docs/00`'s veteran-recognition test).

## 7. Session log

- **2026-08-06** — Install copied from Parallels (679 MB). Both PFFs extracted with the
  existing tool unchanged. Census taken; retail TRN parses; CAL cracked (text, 256
  surface-class rows, referenced by TRN `char_data`); strips confirmed present for all 18
  maps at the documented 64×16384 geometry; BMS/SBF/PWF/DBF/KSA magics fingerprinted;
  ANM/DEF identified as SCR-container and locked. This runbook written.
