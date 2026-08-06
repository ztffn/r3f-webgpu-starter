# df2-extract

Offline converter toolkit for **NovaLogic DF-era game assets** (Delta Force 1/2, Land
Warrior era). Node built-ins only, no dependencies. Today it lives inside the DF2 web-port
repo; it is slated to become a **standalone community repository** — converter plus format
knowledge, separated from the game for IP reasons — so this README stays self-contained:
everything a future maintainer needs is here or explicitly pointed to.

## Tools

| File | What it does |
|---|---|
| `df2extract.mjs` | PFF archive unpack (`list` / `extract`), `.trn` manifest parse (`trn`), `.3DI` model describe/convert (`3di`). Exports `parsePff()`, `parseTrn()` for programmatic use |
| `imageio.mjs` | `decodePcx()` (8-bit RLE + VGA palette), `decodeTga()` (uncompressed truecolor 24/32-bit), `encodePng()` (grey/RGB/RGBA via `node:zlib`), `cstr()` byte-field reader shared by the parsers |
| `file3di.mjs` | `.3DI` V8 model parser and GLB exporter, including embedded palettized texture export |
| `prepare-terrain.mjs` | Turns one extracted terrain into web-ready assets: `height.png`, `color.jpg`, `detail.png` (tile indices), `detail_color.png` (the `_cm` strip repacked as a 16×16 atlas), `detail_elev.png`, the baked `grass.png` canopy field (vegetation families only when a `.cal` is present), and a `terrain.json` provenance record |

```sh
node df2extract.mjs list    path/to/archive.pff
node df2extract.mjs extract path/to/archive.pff  out/dir
node df2extract.mjs trn     out/dir/Something.trn
node df2extract.mjs 3di     out/dir/MODEL.3DI [out.glb] [--lod n] [--scale f]
node prepare-terrain.mjs    out/dir  <trnBaseName>  public/assets/terrain/<slug>
```

## Getting the `.pff`s out of an installer (no Wine/Whisky)

Old DF installers are ordinary Windows self-extracting archives; unpack them statically —
never run the `.exe`:

```sh
file installer.exe                       # identify the wrapper
innoextract -e -d out installer.exe      # Inno Setup wrapper
unzip installer.exe -d out               # WinZip SFX wrapper
```

## Format knowledge (all confirmed against real archives)

- **PFF3/PFF2 container** — 20-byte header, record table near EOF. Records are 32 bytes
  (`deleted, offset, size, mtime` u32×4 + 16-byte NUL-padded name) **or 36 bytes** in later
  PFF3 revisions: the same layout plus a trailing 4-byte checksum (seen in the mission
  editor's `MED.PFF`). No per-file compression. Layout: `docs/02` §1, findings `docs/06` §4.
- **`.trn` terrain manifest** — plaintext key/value index tying a terrain together.
  Retail DF2 keys and the DF1-era `polytrn_*` editor variant both parse with `parseTrn()`.
  `docs/02` §5, `docs/06` §5.
- **Terrain images** — colormap `_c.jpg` (1024² RGB, pre-shaded); heightmap `_d.pcx`
  (1024² 8-bit — `_d` is *elevation*, the `_m.pcx` is the detail map); detail map `_m.pcx`
  (1024² palettized, per-texel tile index); `detail_elev` `_dm.pcx` and `detail_color`
  `_cm.tga` strips (both 64×16384 = 256 stacked 64×64 tiles); sky `clouds<NN>.pcx` (512²,
  shipped set skips 09), sky gradient `skygrd<NN>.tga` (16×257 LUT), water `ripple1.pcx`
  (256²). `docs/02` §5, `docs/06` §6.
- **`.cal` char_data** — plaintext, one `<material>,<param>` line per detail index
  (line *N* = index *N−1*): `Gs*` grass, `Dt*` dirt, `Rk*` rock, `Md*` mud, `rd1` railroad,
  `ct1` concrete, `null`; `param` 40 marks the hard surfaces. `docs/02` §5.
- **`detail_elev` is a general EXTRUSION map, not a grass map** — the original's voxel
  renderer stretched *every* ground column by its detail_elev texel and coloured it from
  the detail_color texel; grass is just the vegetation case. Measured on DFG5: rail
  columns carry stretch 40 and tie planks 20 above ~0 ballast (a physically raised
  railroad), rock/dirt/mud tiles carry 4–14 (stones and ruts), grass families 22–46, and
  the unused `null` tiles are ~255 full-height blocks. Converters deriving a vegetation
  or concealment field from the strip must therefore FILTER BY char_data family (`Gs*`),
  or every dirt rut becomes centimetre grass. `docs/06` §11/§11.1.
- **Detail-texture mapping** — each detail-map texel (1 m) renders its own full 64×64 tile
  (~1.6 cm/px ground resolution). Proven by DFG5's railroad: four *different* tiles in four
  *adjacent* columns compose one continuous track, and the colormap does not paint it at
  all — the track exists only in the detail pass. Full audit: `docs/06` §11.
- **`.3DI` V8 models** — parsed and GLB-convertible (642/644 retail models, exact EOF
  alignment); model units are 1/256 m, calibrated against soldier heights and the egypt
  pyramid footprints. Corrected byte layout: `docs/02` §4. The two failures are
  V7-signature files.
- **`GPM` models** — the mission editor's `MED.PFF` carries older-generation models with a
  `GPM` signature sharing names with retail `.3DI` files; not parsed yet, not duplicates.
- **Scale anchors** — 1 texel = 1 m (maps are 1.024 km square, and they wrap/tile
  infinitely); 256 model units = 1 m. Derivation: `docs/06` §8/§10.
- **Cross-validation** — the editor's `dfg5_d.raw` (512² polytrn sector, tiled 2×2) equals
  the retail heightmap downsampled 2× exactly, independently confirming the PCX decode and
  the wrap-tiling. `docs/06` §11.

Deep detail lives in [`docs/02-asset-format-specification.md`](../../docs/02-asset-format-specification.md)
(byte layouts) and [`docs/06-asset-extraction-findings.md`](../../docs/06-asset-extraction-findings.md)
(ground-truth findings); when this toolkit moves to its own repo those two documents (or
their format sections) move with it.

## Legal / provenance

Extracted **community mod** assets are committed to the game repo's `assets/` (EXP2b and the
community TerrainPack are freeware authored for redistribution by this project's own mod
team — `docs/01` §3, `assets/README.md`), so the pipeline reproduces from source.
**Retail**-extracted DF2 data is different: personal-use-only, never committed, never in a
shared build. The future standalone repo ships converter code and format documentation —
never game data.
