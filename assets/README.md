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

## Skies — third-party, CC0

`public/assets/sky/<preset>/` holds cubemap faces from the **Retro Skyboxes Pack** by
Vladislav Zhukov (https://vladislavzh.net), released under **CC0**: usable in personal and
commercial work with no attribution required. Credited here anyway, and committed on that
basis — unlike most asset-pack material, which this project could not ship.

**Why third-party at all.** Every `.trn` names `clouds01` / `skygrd01` as its sky bitmap and
palette, and neither is in the extracted expansion pack: they live in the retail base-game
archive, which is personal-use-only and never committed (`01` §3). So there is no DF2 sky to
extract, and the alternative to substituting one is no sky at all — which is what shipped
until now, a flat background colour.

Only the PNG faces are copied in — twelve skies, about 12 MB. The pack's `.dds` cubemaps are
for Unreal and account for 120 MB of its 147 MB. Faces are stored as `px/nx/py/ny/pz/nz`,
three's own axis order, so a preset folder says nothing about which pack it came from and
swapping packs touches no code.

The pack's `Land` and `Ocean` variants are deliberately absent: they differ only in the lower
hemisphere, which our terrain covers completely, and their baked ground fights the real one at
the horizon. Preset ids follow what a sky IS rather than what the pack calls it — `Sunshine` is
a black starry sky above a sea of plasma, which makes it our night sky, and its name would have
misled anyone authoring from the folder list rather than from the pixels.

512x512 and visibly banded is the RIGHT resolution here, not a compromise — a modern HDRI
sky above a 1024-texel pre-shaded colormap and 3 cm grass columns would read as two different
games. See `docs/03` on the recognisability test.

### A second pack — Kenney Skyboxes 1.0, also CC0

`kenney-{day,morning,night,alien,space}` come from **Kenney Skyboxes 1.0**
(https://kenney.nl), **CC0**, credited here though not required. They ship as 4096x2048
equirectangular panoramas rather than cube faces, so
`node tools/sky-convert/equirect-to-cube.mjs <panorama.png> <slug> [faceSize]` resamples them
to the same six-face layout and prints the horizon and zenith colours a preset needs — every
colour in the five `k*` presets is measured by that tool, not eyedropped.

**Having two packs is worth more than having more skies.** These are smooth painted gradients
with a graded lower hemisphere; the retro pack is photographic with a hard painted floor. The
haze now samples the sky, so the two stress it in opposite directions — the retro pack is what
proved `hazeLift` has to exist at all, and this pack is the case that wants it near zero.
