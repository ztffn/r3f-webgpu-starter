# Asset Extraction — Field Notes & Confirmed Findings

Ground-truth notes from unpacking **real DF-era terrain data** (community modding
installers), July 2026. Where the earlier specs (`02-...md` §5, `01-...md` §7) were
*hypotheses*, this document records what the actual bytes say. Treat this as the source of
truth over any guess in the other docs; those have been updated to match.

> **Legal / posture (updated July 2026):** the extracted assets **are** committed, to
> `assets/` (raw archives and unpacked source) and `public/assets/terrain/<slug>/` (prepared
> output). They are community mod freeware — EXP2b and a community TerrainPack — in a private
> repo; see `01-...md` §3 and `assets/README.md`. **Retail**-extracted DF2 data remains
> personal-use-only and is not committed. Everything below is reproducible directly from
> `assets/` rather than from a working copy you have to rebuild first.

---

## 1. How to extract (no Wine/Whisky needed)

Old DF modding installers are ordinary Windows self-extracting archives and unpack
**statically** on Linux/macOS. Never run the `.exe`. Identify the wrapper with `file`, then:

| Installer wrapper (`file` says…) | Tool | Command |
|---|---|---|
| `InnoSetup self-extracting archive` | `innoextract` | `innoextract -e -d OUT installer.exe` |
| `ZIP self-extracting archive (WinZip)` | `unzip` | `unzip installer.exe -d OUT` |

Both wrappers here contained NovaLogic **`.pff`** archives. Unpack those with the project's
own parser (`tools/df2-extract`, validated against all files below):

```
node tools/df2-extract/df2extract.mjs list    foo.pff
node tools/df2-extract/df2extract.mjs extract  foo.pff  OUTDIR
node tools/df2-extract/df2extract.mjs trn      OUTDIR/Something.trn
```

---

## 2. Installers seen so far

### `TerrainPack.exe` — Inno Setup, ~16 MB (our own ~2003 pack)
Contains three `.pff` archives (`app/df1.pff`, `app/evil.pff`, `app/lw.pff`) →
**27 terrains** (DF1 desert/snow, "evil" river maps, 20 Land Warrior maps). These terrains
carry colormap + heightmap + detail_map but **reference base-game detail sets** (`dfd2_*`,
`dfg4_*`) for grass stretch/color — those are *not* bundled.

### `EXP2b.exe` — WinZip SFX, ~20 MB (TerraNova EXP2b expansion)
Contains one large `EXP2.PFF` (34.5 MB, 129 files) → **9 terrains** plus, crucially,
**bundled detail-set assets** the other pack lacked. This crew authored their own
per-terrain `detail_map` and bundled two complete `detail_elev` strips.

---

## 3. Terrain inventory

| Pack | Terrains |
|---|---|
| `df1.pff` | Desert3, Desert6, Desert7, snow1 |
| `evil.pff` | open, river1, Waterway |
| `lw.pff` | D1, D2, D4, D6, D7, DG1, DG2, DG4, G2, G4, G5, G6, G7, G8, G9, G10, G11, GI1, GI2, W1 |
| `EXP2.PFF` | 1stlook (Look), bal001 (Balnakiel), gmile (Green Mile), river, ds001, egypt, R66, blizzard, vul001 |

---

## 4. Confirmed: PFF3 container

`02-...md` §1 verified byte-exact against real archives. Header at offset 0:
`HeaderSize=20`, magic `PFF3` (`0x33464650`), then `RecordCount`, `RecordSize=32`,
`RecordOffset`. The **record table sits at the end of the file** (`RecordOffset` points near
EOF). Each 32-byte record: `Deleted, FileOffset, FileSize, FileModified` (u32 ×4) + 15-byte
name + 1 pad. No per-file compression. Filenames are plain (e.g. `Desert3_c.jpg`).

---

## 5. Confirmed: the `.trn` terrain manifest (plain text)

Each terrain is defined by a small (~470–490 byte) **plaintext** `.trn` file inside the
`.pff`. It is the index tying everything together. Example (Green Mile):

```
terrain_name     "EXP2-Green Mile"
terrain_creator  "Celtic"
color_map         ct502_c        # -> ct502_c.jpg   (colormap)
elev_map          ct502_d        # -> ct502_d.pcx   (HEIGHTMAP; "_d" = elevation)
detail_map        ct502_m        # -> ct502_m.pcx   (per-texel detail/material index)
detail_color      dfdg1_cm       # -> detail COLOR strip   (shared base-game set here)
detail_elev       dfdg1_dm       # -> detail ELEVATION strip (grass stretch heights)
char_data         dfdg1_cm
sky_map           clouds01
sky_palette       skygrd01
sky_height        1236
horizon           1
water_map         ripple1
water_height      0
filter            128, 128, 128  # RGB tint
gamma             128
saturation        128
sun_slope         70
```

**Naming convention** (learned from the data): `_c` = colormap, `_d` = elevation/heightmap,
`_m` = detail/material map, `_dm` = detail-elevation strip, `_cm` = detail-color strip.

---

## 6. Confirmed: the terrain asset model (corrects `02-...md` §5)

| Role (`.trn` key) | File | Real format & size |
|---|---|---|
| `color_map` | `<t>_c.jpg` | **JPEG**, 1024×1024 RGB (pre-shaded — baked lighting/shadow visible) |
| `elev_map` (heightmap) | `<t>_d.pcx` | **PCX, 1024×1024, 8-bit greyscale.** This is the heightmap. |
| `detail_map` | `<t>_m.pcx` | **PCX, 1024×1024, 8-bit palettized.** Per-texel index selecting a detail tile. High-frequency (dithered blends), not big flat zones — Green Mile uses **62 distinct indices**. |
| `detail_elev` | `<set>_dm.pcx` | **64×16384 greyscale strip = 256 tiles of 64×64.** Tile _i_ = grass **stretch height** for detail index _i_. |
| `detail_color` | `<set>_cm.tga` | **64×16384 RGBA strip = 256 tiles of 64×64.** Close-up ground textures per detail index. |

Corrections vs. the earlier guess: colormap is **JPEG not TGA**; the heightmap is the
`_d.pcx` (the `_m.pcx` is the *detail/material* map, not the heightmap); the
detail-elev/detail-color "strips" are concretely **256 stacked 64×64 tiles** indexed by the
detail-map value.

### The grass data model (the concealment success metric)

```
detail_map[x,z]  (1024², index 0–255)
      │  index → tile
      ▼
detail_elev strip  (256 × 64×64 greyscale)  →  grass STRETCH HEIGHT at (x,z)
```

This is exactly the `grassHeightField` of `04-concealment-system-design.md`: bake a 1024²
map by looking up each `detail_map` texel's index into the `detail_elev` strip (a
per-tile representative height, e.g. mean, or the full 64×64 tile if sub-texel grass
variation is wanted). Both the renderer (`03-...md` §4.1) and the concealment query
(`04-...md`) read that same field.

---

## 7. What we have vs. what's missing (grass/concealment data)

`detail_map` (zoning) is **bundled for every EXP2b terrain** — solved. `detail_elev` (the
stretch heights) is the gating asset:

| Terrain(s) | detail_map | detail_elev (stretch) | Self-contained? |
|---|---|---|---|
| **egypt** | ct501_m ✓ | **ct1_dm ✓** (+ ct1_cm ✓) | ✅ fully |
| R66, blizzard, vul001 | ✓ | **ct2_dm ✓** | ✅ stretch present (color strip missing) |
| **Balnakiel, Green Mile, 1stLook, river, ds001** | ✓ | `dfdg1_dm` ✗ | ❌ needs base-game grass set |

**Bundled, usable detail-elev strips:** `ct1_dm`, `ct2_dm` (both 64×16384). These are enough
to **build and validate the entire Phase 2 grass + Phase 3 concealment pipeline with zero
base-game files.**

### 7.1 Green Mile's substituted canopy is ANKLE HEIGHT — measured

Decoded from `public/assets/terrain/gmile/grass.png` (1024², one byte per texel), converted
with the shipped `GRASS_SCALE` of 0.0047 m per raw unit:

| | raw | metres |
|---|---|---|
| 25th percentile | 10 | 0.047 |
| **median** | **28** | **0.132** |
| 75th percentile | 44 | 0.207 |
| 95th percentile | 72 | 0.338 |
| 99th percentile | 116 | 0.545 |
| maximum | 255 | 1.199 |

Mean 30.7 (0.144 m). **11.2% of the map has no canopy at all.**

Against the stance eye heights in `FlyControls.STANCE_EYE` — 1.7 m standing, 0.95 m crouched,
0.35 m prone — **crouch is above essentially all the grass on this map and prone is above 95%
of it.** Concealment cannot work here regardless of how good the renderer is, and no amount of
shader work will change that.

`GRASS_SCALE` was calibrated so raw **255** maps to 1.2 m, staying under standing eye height
(`08` §8 invariant 4). But the field almost never approaches 255, so the TYPICAL column lands
at a tenth of the intended height. The invariant constrains the wrong end of the distribution.
A straight linear rescale cannot fix it either: pushing the median to concealment height sends
the maximum to eight metres.

**This is a substituted stand-in** (`grass.assets.substituted: true`, derived from the
colormap), so it says nothing about what real DF2 canopy looked like. Do not recalibrate
`GRASS_SCALE` against it. Prepare **egypt** or **R66/blizzard/vul001**, which ship genuine
`detail_elev` strips, and measure the real distribution first.

Also worth knowing: the long-standing benchmark vantage `x=5&z=375` sits on a texel with raw
**0**. Every grass measurement taken there was a march over bare ground — which is why
`?bench=1` now forces full canopy (`09` §0).

**Still needed for the marquee grass maps specifically:** `dfdg1_dm` / `dfdg1_cm` (and
`dfg1_cm`) — the standard DF2 grass detail set, which lives in a **base-game `.pff`** (not in
either modding installer).

> ⚠️ **Correction (July 2026).** This section previously advised reproducing those maps' grass
> "using `ct1_dm`/`ct2_dm` as a stand-in stretch set". **Do not.** Strip tile *indices* are
> per-grass-set, so a terrain's `detail_map` indices mean nothing against another set's strip:
> grass comes out tall where the map should be bare and bare where it should be chest-high.
> Plausible-looking and wrong. `loadTerrain.ts` refuses a bake tagged `substituted` and uses a
> labelled colormap-derived stand-in instead (`08-...md` §5.3).
>
> **The right move is the opposite one: test real grass on a map that actually has its strip.**
> Per the table above, **egypt** (`ct1_dm`) and **R66 / blizzard / vul001** (`ct2_dm`) are
> self-contained — preparing any of those yields `grassSource: "real"`, the authentic
> `detail_map` → strip → stretch-height path, end to end. That is the only way to exercise
> the real data path at all right now, and it is the strongest argument for the multi-map
> loader in `01` Phase 1.6. It also unblocks acceptance criterion 3 in `07-...md` §3 ("hard
> zone edges"), which is untestable on Green Mile by construction.
>
> Note what this does **not** get you: the *classic DF2 grass look*. `ct1`/`ct2` are the
> correct strips for their own terrains, not a substitute for `dfdg1`'s profile.

---

## 8. Still unconfirmed (needs base game or more probing)

- **Stretch-height → world-units scale.** The `detail_elev` greyscale (0–255) maps to some
  world height; the multiplier (and whether it's modulated by `sun_slope`/terrain scale) is
  not yet pinned. Tune visually against the real map, then confirm if base-game data clarifies.
- **Heightmap → world-height scale & meters-per-texel.** 1024² grid confirmed; the vertical
  scale and horizontal spacing (map world size) are still `HEIGHT_SCALE` / `METERS_PER_TEXEL`
  constants to calibrate.
- **detail_map palette semantics.** Whether the palette RGB carries meaning or the index is
  purely a strip key (current assumption: index is the key). Per-terrain authored, not fixed.
- **`dfdg1_dm` contents** — the actual grass stretch profile of the classic DF2 grass.

---

## 9. Tooling status

`tools/df2-extract/`, all validated against real archives:

- ✅ PFF3/PFF2 unpack + `.trn` parse + inventory (`df2extract.mjs`)
- ✅ PCX 8-bit RLE decode, PNG encode via `node:zlib`, JPEG passthrough (`imageio.mjs`)
- ✅ `grassHeightField` bake, with provenance tagging so a substituted strip is refused at
  load time (`prepare-terrain.mjs`, `--detail-elev` override)
- ⬜ TGA decode — not needed by the terrain path yet (`detail_color` strips only)
- ⬜ `.3DI` → glTF — not started

**Phase 0's core is done.** Remaining Phase 0 work is model conversion only, which is off
the terrain/grass critical path — see `01-...md` roadmap.

---

## 10. Terrain tiles infinitely (confirmed by original play experience)

DF2 terrain has **no edges** — the 1024² tile repeats seamlessly in x and z forever. This is
intrinsic to the Voxel Space column raycaster: the ray march samples the heightfield modulo
the map size, so there is no boundary to reach. Players could drive or fly in one direction
indefinitely and terrain kept coming.

**Implications, now implemented:**

- Heightfield sampling **wraps modulo the map period**, never clamps. The field stores
  exactly `period × period` distinct samples (no duplicated edge row).
- The colormap uses `RepeatWrapping`; UVs run past `[0,1]` and repeat.
- The renderer maintains a **camera-centred moving window of chunks** rather than a fixed
  grid over one map instance. Because the map tiles, chunk `(cx, cz)` and
  `(cx + period, cz)` are identical, so geometry is cached by *wrapped* chunk index and
  shared across every repeat on screen.
- The synthetic fallback uses **periodic** fBm (lattice wrapped per octave) so it tiles
  seamlessly too.
- Verified numerically: sampling one tile-width apart returns bit-identical heights
  (error 0.000000), and crossing a tile seam shows no discontinuity beyond
  finite-difference epsilon (~0.01% of relief).

Any future gameplay system (concealment line-of-sight in particular) must wrap the same
way, or sightlines will break at an invisible boundary.
