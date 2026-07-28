# df2-extract

Offline asset pipeline for the DF2 web port (Phase 0). Node built-ins only, no deps.

**Status:** the validated core — PFF3/PFF2 unpack + `.trn` manifest parse — is implemented
and confirmed against real DF-era archives (see
[`../../docs/06-asset-extraction-findings.md`](../../docs/06-asset-extraction-findings.md)).
Image decoders (PCX 8-bit RLE, TGA, JPEG passthrough) and the `grassHeightField` bake are the
remaining Phase 0 work.

## Getting the `.pff`s out of an installer (no Wine/Whisky)

Old DF modding installers are self-extracting Windows archives; unpack them statically:

```sh
file installer.exe                       # identify the wrapper
innoextract -e -d out installer.exe      # Inno Setup wrapper
unzip installer.exe -d out               # WinZip SFX wrapper
```

## Usage

```sh
node df2extract.mjs list    path/to/terrain.pff
node df2extract.mjs extract path/to/terrain.pff  out/terrain
node df2extract.mjs trn     out/terrain/Something.trn
```

`parsePff()` and `parseTrn()` are also exported for programmatic use.

## Asset model (confirmed)

Per terrain, inside the `.pff`: a plaintext `<name>.trn` manifest + `_c.jpg` colormap (1024²
RGB) + `_d.pcx` heightmap (1024² 8-bit) + `_m.pcx` detail map (1024² palettized). The
`detail_elev`/`detail_color` "strips" (`_dm.pcx` / `_cm.tga`, 64×16384 = 256 tiles of 64×64)
may be shared base-game sets referenced by the `.trn`. Full detail in
[`docs/02`](../../docs/02-asset-format-specification.md) §5.

## Legal

Do **not** commit extracted assets (mixed NovaLogic + community authorship). Output belongs in
a git-ignored `assets/` working area.
