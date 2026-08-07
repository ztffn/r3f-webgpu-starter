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
side-by-side. **Oracle:** `Novahq-net/Nova3di` — a maintained C++ 3DI(v2–10)→OBJ converter
(textures, collision meshes, hardpoints, LODs; author reports ~20k models tested). It's a
Win32 exe: build/run it in Parallels over a handful of retail 3DIs and validate our Node
inspector against its OBJ output instead of eyeballing. Source cross-references, in order:
`Acruid/NovalogicTools` `File3di.cs` (DF2-specific, the source `docs/02` was ported from),
`Acruid/nl-gfxedit` (DF2 3DI8 viewer/editor with tests — renders, so it validates layout
end-to-end), then opennova's `Model/` code (JO-era).
**Done when:** the batch scan passes on all 644 or the spec is amended where it fails, and
our inspector's geometry matches Nova3di's OBJ for the spot-check set.

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
  No license → read, don't copy. Last push 2024.
- **Nova3di** — https://github.com/Novahq-net/Nova3di — C++ converter, 3DI v2–v10 (all DF-era
  games) → OBJ with textures, collision meshes, hardpoints and LODs; **actively maintained**
  (pushed 2026-05) and tested against ~20k models per its README. W5's oracle: run the exe in
  Parallels to produce reference OBJs our decoder must match. No license → read, don't copy.
- **nl-gfxedit** — https://github.com/Acruid/nl-gfxedit — same author as NovalogicTools; a
  C#/OpenTK **3DI8 viewer/editor specifically for DF2**, with tests. Later and likely more
  complete than `File3di.cs` — a rendering editor validates fields a parser can silently get
  wrong. No license → read, don't copy. Last push 2023.
- **NovaResearch** — https://github.com/Novahq-net/NovaResearch — **read this BEFORE
  inferring any layout.** `Shared/3DI File Format.md` is precise per-version documentation
  (fixed-point conventions, mesh-relative indices, texture ratios, v10 differences) and it
  corrected three of this project's inferences in one sitting — each of which had already
  shipped a visible bug. Same org as NHQTools/Nova3di/NovaPff. No license → read,
  don't copy.
- **NHQTools** — https://github.com/Novahq-net/NHQTools — .NET 4.8 library for NovaLogic
  formats with **`.def` decryption and an `Scr` serializer** — i.e. the W7 SCR container
  handled upstream — plus PFF/PAK/BFC, PCX/DDS/R16/TGA/FNT and BIN/MNU serializers.
  Related: `Novahq-net/NovaPff` (GUI archive tool) and `Novahq-net/NovaResearch` (format
  research notes). No license → read, don't copy.
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
  ANM/DEF identified as SCR-container and locked. This runbook written. Reference repos
  vetted: `Acruid/NovalogicTools` (recovered from git history — the `docs/02` source),
  `Novahq-net/Nova3di` (maintained 3DI→OBJ oracle) and `Acruid/nl-gfxedit` (DF2 3DI8
  editor) added alongside opennova; none carries a license, all read-don't-copy.
- **2026-08-06 (later)** — **W1 half-done and W5 done in one stroke.** The egypt pyramids
  turned out to be placed objects on flattened pads, and the model is retail
  `KHUFU.3DI`. Built `file3di.mjs` (V8 parser + GLB export, `df2extract.mjs 3di`);
  642/644 retail models parse with exact EOF alignment; `docs/02` §4 corrected
  (36-byte LodInfo, 112-byte sub-objects, texture body, 24.8 UVs, 256 units/m).
  **`METERS_PER_TEXEL` calibrated = 1.0** from soldier-height (1.83 m) + pyramid painted
  footprint (170 texels ↔ 173.6 m); verified in-renderer with the converted GLB standing
  on its painted base (`?map=egypt&obj=khufu&objat=596,198.5`). Egypt is now a prepared
  terrain (`public/assets/terrain/egypt`, real grass strips). `HEIGHT_SCALE` remains W1's
  open half. MED.PFF is a PFF3 variant with 36-byte records our parser rejects — extend
  `parsePff` when the mission-editor item DB (type_id → 3DI name) is needed; BMS item
  records are numeric `type_id`s, so that table is the W4 gate. NHQTools (see §6) likely
  unlocks W7 outright.
- **2026-08-06 (validation set + dials)** — bone-relative vertex offsets (`Flags & 1`,
  `VecOff >> 8`) implemented in the GLB export; seven more objects converted for the
  human scale check (HUMVEE measures 4.8×2.3×2.0 m vs the real HMMWV's 4.6×2.16×1.83 —
  the strongest vehicle confirmation of 256 units/m; exported bounds match the LOD-header
  bounds exactly). `?obj=` now takes a comma list and lines objects up eastward.
  Terrain-scale calibration dials added to the bench vocabulary: `?texel=`, `?hscale=`,
  `?hsmooth=` — offline instruments for dialling `HEIGHT_SCALE` against the retail game.
  The same three dials are LIVE SLIDERS in the dev console's Scene tab (URL seeds them,
  sliders commit on release because a commit rebuilds the whole world, "Reset to
  calibrated" returns to config).
- **2026-08-07 — W1 CLOSED, and W4's gate with it.** Triggered by a community mission
  (`Warfields`, varg 2004, on retail DMD3) and the question of whether a rebuild could
  calibrate height by looking for buried objects. It cannot — mission `z` is an OFFSET
  (366 of 416 items are exactly 0), so objects seat on whatever terrain you give them and
  carry no scale signal; footprint relief under the 125 large objects is statistically
  indistinguishable from random ground (median 3-4 raw either way), so "designers avoided
  slopes" is not a usable constraint either. **The answer came from the manual instead:**
  `DF2MED.PDF` says water level is in 1/2 metres, so `HEIGHT_SCALE = 0.5` (docs/06 §8).
  Also settled on the way: the deliberate non-zero mission `z` values are round metres
  (-256 = -1.00 m, +768 = +3.00 m), confirming mission coordinates use the 3DI 1/256 m
  unit — the assumption flagged as unverified the day before.
  **W4's type_id gate is open:** `MED.PFF` (readable only since the 36-byte-record fix)
  carries `ITEMS.DEF` in PLAINTEXT — 727 item definitions where `type_id = id - 100000`
  and a `graphic` field names the `.3di`. All 416 Warfields items resolve (365 with
  models, 48 markers, 3 model-less decorations); all 40 distinct models are in the corpus.
  MED.PFF also ships raw uncompressed 1024² heightmaps for all 18 maps plus a `DMG7` that
  is not in Terrains.pff.
- **2026-08-07 (mission import built, and the lesson).** `mission.mjs` (ITEMS.DEF + .mis
  readers), `df2extract.mjs mission` (emits `mission.json` + one GLB per referenced model),
  and `MissionObjects.tsx` (`?mission=`) render Warfields' 365 objects on DMD3. Atmosphere
  is deliberately NOT imported — the project's own presets and the room own visuals.
  **Three .3DI bugs surfaced only by looking at the screen**, and all three were my
  inferences rather than measurements: textures tiled wrong (UVs are 16.16 NORMALISED, not
  texel coords — the 24.8 reading is identical for 256-wide textures and wrong for all
  others, so it looked right on the pyramid), the T-80 had no turret or gun (face indices
  are SUB-OBJECT LOCAL), and every object sat a quarter-turn off (model forward is +X, a
  mission facing is a compass bearing). **The fix for all three was in NovaResearch's
  format doc the whole time** (§6) — read the spec before inferring a layout, and prefer a
  multi-part, non-square-textured model over a pyramid when spot-checking a converter.
- **2026-08-07 — object ORIENTATION rules, derived from ITEMS.DEF rather than assumed.**
  Two behaviours a converter has to get right, both now read out of the data:
  **(1) Tilt comes from the mission.** `facing` carries two angles; the second is a tilt
  that 328 of Warfields' items leave at 0. Every item that uses it is wreckage or toppled
  masonry (Black Hawk / Gazelle / T-80 husks, 33 stone columns, a shell), which is what
  makes it safe to apply.
  **(2) Ground vehicles conform to the slope; nothing else does.** `axle_dist` is present
  for exactly the 30 vehicles with a ground movement function (`veh0`/`carg`/`loco`/`boat`/
  `herc`) and absent for all 30 without one — every helicopter and every husk, 30/30 with
  no exceptions. An axle distance exists to find where the wheels touch. **Trap:** the
  field is a reused slot and the "tree with sound" decorations all carry a uniform 10, so
  the rule must be `type == vehicle AND axle_dist` — keying on the field alone tilted 26
  trees into the hillside. In Warfields this marks 3 objects (the live T-80s).
  The `Snap` flag in ITEMS.DEF's header is a red herring — declared, never used by any of
  the 727 items, and the editor manual shows it means grid snap in the UI.
- **2026-08-07 — the placement transform, SETTLED from a reference implementation.**
  The remaining unknowns (axis convention, yaw offset, whether props conform) were not
  derivable here: the manuals say nothing about slopes, NovaResearch has no mission page,
  and this map's objects sit on open ground so nothing correlates. **opennova's
  `Mission/MissionEntity.cs` has the whole transform**, and it is worth reading in full
  before touching mission placement again:
  - `GetWorldPosition()` rotates the raw vector -90° about X → `(x, y, z)` becomes
    `(x, z, -y)`. Mission **+y is NORTH**; our world +Z runs south. Axis = `x,-y`.
  - `GetWorldRotation()` = `FromEuler(-pitch, π - yaw, +roll)` in **YXZ** order. So
    **yaw = 180° - facing** — reasoning from "model forward is +X, bearings clockwise"
    gives 90 and is WRONG — pitch is negated about X (about Z rolls wreckage sideways
    instead of tipping it), and roll is positive about Z.
  - **It never consults the terrain.** Every entity is placed from its stored rotation
    alone, so statically placed vehicles stand as authored; `axle_dist` is about
    ground contact for things that DRIVE, not about load-time placement. Conforming is
    therefore OFF by default (`?misconform=1` to see it).
  Also there, and the answer to W4's binary half: the **BMS entity struct** —
  `TypeId/NameIndex/Id/BmsiAttributes` (4×i32), `X/Y/Z` as i32÷65536, six i32 AI fields,
  then `WAccuracy2/1`, **`Yaw/Pitch/Roll` as i16**, `Spawns`. Three angles, where DF2's
  text `facing` writes two — so DF2's second value is pitch. Its `Mission/AttribFlags.cs`
  decodes the mission `attrib` bitmask too (Warfields' 536870912 = `TeamDeathmatch`; note
  bit 5 is `RotateMap180`, which a converter must honour).
  Caveat carried: opennova targets Joint Operations, two generations later — treat the
  conventions as inherited-but-unconfirmed for DF2 until seen against the retail game.
- **2026-08-07 — the mirrored-model bug, and why a yaw offset could never fix it.**
  Applying the reference transform still left objects visibly a quarter-turn out, because
  the fault was upstream in the GLB exporter: it converted z-up to y-up with
  `(x, y, z) -> (x, z, y)`, a REFLECTION, and compensated the resulting inward normals by
  reversing triangle winding. That renders plausibly — faces point outward, symmetric
  props are indistinguishable — while every model is silently its own mirror image. A
  mirror is not in the rotation group, so no yaw offset anywhere can undo it, which is
  exactly why chasing 0 -> 90 -> 270 -> 180 never converged. Correct is the -90° rotation
  `(x, y, z) -> (x, z, -y)` with winding LEFT ALONE and normals given the same rotation.
  Generalisable lesson: when a reflection is suspected, stop turning the dial — check the
  determinant of the basis change instead. And spot-check converters on an ASYMMETRIC
  model; every symmetric prop in the corpus was hiding this.
- **2026-08-07 — placement convention SETTLED by measurement, correcting opennova.**
  The right instrument was a second map: **KillRing** (Varg, 2001) on DFG4, whose author
  describes it as a swamp arena ringed by a circular wall. Both unknowns fall out of it,
  and BOTH contradict the Joint Operations reference:
  - **Axis is `x,y`, not `x,-y`.** DFG4's water sits at raw 11; inside the ring `x,y` puts
    the arena **98% below the water line** against a 72% map-wide baseline, while `x,-y`
    gives 74% — i.e. indistinguishable from anywhere else on the map. The arena was dug
    into a swamp and only one mapping reproduces that.
  - **`yaw = facing - 90`, not `180 - facing`.** A wall on a circle must be TANGENT, which
    is one constraint per segment: across all 195, `facing + theta = 90 (mod 180)`. That
    fixes the yaw to within the 180° a symmetric wall panel cannot resolve. The last 180°
    comes from two asymmetric props that agree — the four 50-cals around the central tower
    face outward and the four ladders present their climbing side away from it (both
    models carry their geometry offset along +X, the forward axis; the 50-cal by 0.74 m,
    which is its barrel). Verified: all 195 segments tangent to within 4.8°.
  **Method note worth more than the result:** a circular wall is a near-perfect calibration
  target — 195 independent angular constraints from one prop — and an author's own
  description ("swamp arena") is testable terrain ground truth. When a convention will not
  fall out of the data, look for a map built around a shape or a claim. Cross-generation
  references are leads, not answers; opennova was right about pitch/roll/order and wrong
  about both position and yaw.
- **2026-08-07 — material flags: double-siding, hidden faces, colour key, unlit.**
  Prompted by "the tent and parts of buildings should be double sided". They are, and the
  file says so: `ModelMaterial.Flags` is a **u32 at offset 16**, not the byte the C#
  reference declares — a byte drops bits 8-15 and with them ColorKey, Hidden and
  AlphaBlend. 32.8% of the corpus's 18,115 materials are DoubleSided, and it falls exactly
  where expected (tent canopies, foliage, building interiors; not crates or masonry).
  The exporter now honours DoubleSided, Hidden (drops those faces — 1.0% of materials),
  ColorKey (palette index 0 → transparent, which 1-byte foliage textures need), AlphaBlend
  and FlatLit (as `KHR_materials_unlit`), and groups primitives by texture AND flags so two
  materials sharing a texture cannot collapse into one. `docs/02` §4 has the bit table.
  **Bonus for the ballistics branch:** bits 13 and 16-28 are set throughout but undocumented
  for v8 — the v10 page assigns that region to *bullet-impact surface types*, and the v8
  corpus uses it in 43 distinct patterns. Every material already carries what a round
  hitting it should do; the model-side counterpart of terrain `char_data`.
  **Two same-session corrections, both found by standing inside a building:**
  (1) **`Hidden` must not be acted on.** Dropping those faces removed 28 of `rbuilda`'s
  454 — a 12.2 × 6.9 m band of interior wall. Parse the bit, ignore it; the flag is
  conditional in some way v8's notes miss (its materials also lack TEXTURED and set
  HIDDEN_AUTO). A documented flag acted on without a visual check cost real geometry.
  (2) **Magnify with NEAREST.** Textures are 8–64 px and the engine point-sampled them;
  bilinear magnification rounds window corners and smears alpha into a halo. Window glass
  is real graduated alpha (169 distinct values), so `AlphaBlend` means blend, not cutout —
  the softness was the sampler, not the format.
  (3) **Green fringe on the trucks = chroma key bleeding through the mip chain.**
  Transparent texels store the key colour and on DF2 assets it is frequently pure green
  (`palette[0]` on the EdBro husk is `(0,255,0)`). Mip generation averages RGB regardless
  of alpha, so it blooms into the silhouette with distance — which reads as LOD fading and
  is not. Fix is alpha-bleed: dilate real colour into transparent texels to FULL coverage
  (a few passes is not enough — the deepest mip averages the whole image). Verified 0
  chroma-green texels remaining across 58,375 transparent texels in four vehicle models.
- **2026-08-07 — collision and surface identity are BOTH embedded in the .3DI.**
  Answering "how does a bullet know it hit a wooden box or a metal wall": two separate
  mechanisms, both in the model file, and the sections this parser used to skip.
  **Geometry:** 388 of 623 models carry collision — 23,461 planes, 3,083 volumes. Convex
  volumes bounded by half-space planes with BSP child indices, SEPARATE from the render
  mesh and far coarser (a 475-face adobe building → 18 volumes / 146 planes). Planes now
  parsed and verified: normals are 1.14 fixed (÷16384) and all 23,461 come out unit
  length; a crate's six planes sit at exactly its mesh extent. Volume header layout is
  NOT solved — the documented v5/v8 struct does not describe those 80 bytes (see docs/02
  §4.5) — so they stay raw.
  **Identity:** the surface type is on the MATERIAL, in flag bits 16-19/26-29. Verified
  against the corpus: the cypress carries the "foliage/leaves" bit, the flags carry
  "cloth/flag", a wooden crate bit 17, a metal wall bits 16+17, a stone column bit 18.
  So the engine resolves the hit surface from the material of what was struck, not from
  the collision volume — which is why the volumes need no material reference.
  Directly relevant to `feat/server-ballistics`: impact effect, sound and likely
  penetration all key off this, and it pairs with the terrain's `char_data` classes.
  **Plane-to-hull grouping SOLVED the same session:** `planeCount` is a u32 at volume
  offset 72 (equals `nColPlanes` in all 154 single-volume models, and no other offset
  does), and volumes own CONTIGUOUS plane runs (`sum(planeCount) == nColPlanes` in all
  234 multi-volume models, zero mismatches) — the same ownership pattern sub-objects use
  for vertices. Verified: CRATE1's single hull is an exact axis-aligned box matching its
  mesh extent; ADOB3 decomposes into 18 convex chunks. The rest of the volume header
  (documented bbox, BSP children) still does not read correctly and is left raw — nothing
  needs it. **Design record: `plans/2026-08-07-prop-collision-design.md`.**
- **2026-08-07 — self-audit: `plans/2026-08-07-converter-known-gaps.md`.** Every field the
  converter skips, every unread NovaResearch page, every belief never measured, in one
  list. Written because this session's faults were all found by a human noticing something
  on screen and then fixed in minutes from documentation that already existed. Two closed
  on the spot: the face `Flags` u16 at offset 0 (the C# reference calls it `null0`) is real
  and **bit 0 = smooth-shaded** — ignoring it applied per-vertex normals to flat faces and
  rounded off every hard edge on crates and walls; and winding was re-verified 100% outward
  under the final rotation. Highest-value cluster remaining is that audit's §D: NovaResearch
  has pages for `SCR` (workstream 7, listed as "locked, needs Ghidra on Cmprssh0.dll" since
  this runbook was written), `RTXT`, `AIN` and six more that nobody has opened.
