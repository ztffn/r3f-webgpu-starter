# Raw extracted game data

Source data for `tools/df2-extract`. This is the **input** side of the pipeline; the
web-ready output it produces lives in `public/assets/terrain/<slug>/`.

Committed deliberately so the pipeline is reproducible from source rather than depending on a
working copy that lives on one machine. See README § Asset policy and `docs/01` §3 for the
posture; `docs/02` for the byte-level formats and `docs/06` for what was confirmed against
this data.

## Layout

```
exp2b/                TerraNova EXP2b expansion (WinZip SFX installer)
  EXP2.PFF            the PFF3 archive itself, 33 MB
  extracted/          unpacked contents — 9 terrains
terrainpack/          community TerrainPack (Inno Setup installer, ~2003)
  df1/                DF1-era desert/snow terrains
  evil/               open / river1 / waterway
  lw/                 20 Land Warrior terrains
```

36 `.trn` manifests, 47 PCX, 46 JPEG, 10 TGA, plus `.bms` / `.wav` / `.pwf` / `.dbf` that the
terrain path does not use.

## Naming (confirmed — `docs/06` §6)

| Suffix | What it is |
|---|---|
| `_c.jpg` | colormap, 1024², **pre-shaded** (lighting and shadow baked in) |
| `_d.pcx` | **heightmap** (`elev_map`), 1024² 8-bit greyscale — *not* a detail map |
| `_m.pcx` | detail map, 1024² palettized — per-texel zoning index 0–255 |
| `_dm.pcx` | detail **elevation** strip, 64×16384 = 256 tiles of 64×64 — grass stretch height |
| `_cm.tga` | detail **colour** strip, same tiling — ground textures per index |

The `_d` / `_m` pairing is the single easiest thing to get backwards here.

## Grass strips — which terrains are self-contained

Grass height needs a terrain's `detail_map` index resolved against the `detail_elev` strip its
`.trn` names. Strip tile indices are **per grass set**, so substituting another set's strip
produces plausible-looking wrong grass — see `docs/06` §7.

- **`ct1_dm` present** → egypt is fully self-contained.
- **`ct2_dm` present** → R66, blizzard, vul001 have real stretch data.
- **`dfdg1_dm` missing** (lives in a base-game `.pff` we don't have) → Balnakiel, Green Mile,
  1stLook, river, ds001 fall back to a labelled colormap-derived stand-in canopy.

So the authentic grass path is testable today — just not on Green Mile.

## Regenerating prepared assets

```sh
node tools/df2-extract/df2extract.mjs list    assets/exp2b/EXP2.PFF
node tools/df2-extract/df2extract.mjs extract assets/exp2b/EXP2.PFF assets/exp2b/extracted
node tools/df2-extract/prepare-terrain.mjs \
     assets/exp2b/extracted gmile public/assets/terrain/gmile
```

**Extract installers statically — never run them.** `innoextract` for Inno Setup wrappers,
`unzip` for WinZip SFX. No Wine, no VM.
