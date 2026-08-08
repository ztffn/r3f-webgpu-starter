# tools/fphands — first-person hands + weapons prepare step

Turns the authored Blender export into the runtime rig the browser loads.

```sh
npm run prepare:fphands                       # all ten weapons + hands, 1024px textures
node tools/fphands/prepare-fphands.mjs --only sniper,carbine --size 2048
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--source` | `_tempAssets/3d/FPHands/export` | the Blender export; **gitignored**, not in every checkout |
| `--out` | `public/assets/weapons` | committed runtime output |
| `--size` | `1024` | max texture edge, rounded down to a multiple of 4 |
| `--only` | all ten | comma-separated weapon keys |

Input is ~150 MB of uncompressed GLB; output is ~49 MB of Draco geometry with KTX2
UASTC+Zstd textures, plus `index.json`. **The output is committed and the source is not**,
so a checkout without `_tempAssets/` still renders — the script exits with a clear message
rather than a stack trace when the source is missing.

Needs `toktx` on PATH (KTX-Software). The runtime needs the Basis transcoder committed at
`public/basis/` and the Draco decoder at `public/draco/`; a CDN would be blocked by the
page CSP.

## What it validates, and why each check exists

The Blender exporter fails quietly in ways that only show up as a weapon that never
animates, so this refuses or reports rather than shipping the result:

- **Core clips.** Missing `idle`, `weapon_up`, `weapon_down` or the primary action
  (`shoot`, or `attack_slice1` for the knife) is fatal. Any other documented segment that
  did not export is a warning recorded in the manifest as `missingSegments`.
- **Keyframe rebase.** Every clip must start at t=0. Blender writes NLA keyframe times at
  their absolute timeline position, and the export pipeline patches that out by hand;
  skipping it yields clips that play at the right speed but start seconds into a timeline
  that does not exist. That reads as "wrong duration" and is invisible in a frame count.
- **Muzzle flash.** Every weapon but the knife must carry a node named exactly
  `muzzlemesh`. The runtime matches exactly too — `/muzzle/i` also matches real hardware
  like `Pistol_Muzzlebreak`.
- **No hands in a weapon file.** The output is re-read and asserted. `sniper.glb` ships a
  second full copy of the hands, and the strip is easy to get wrong in a way that still
  looks like it worked (see below).

## Two traps this script exists because of

**Disposing a node does not remove its subtree, and `detach()` removes even less.**
`sniper.glb` carries `Hands_Armature`, its 49 bones, the skinned `Hands_Mesh` and 8.31 MB
of arm textures as a second scene root — no other weapon does. Detaching that root leaves
every bone alive, and `prune` then correctly declines to remove them because a live `Skin`
still cites them. The subtree is collected before anything is disposed, and boneless skins
are dropped after.

**Disposing a Material does not dispose its extension properties.** The stripped hands
material's `KHR_materials_specular` node outlives it and keeps `armsmoothness` reachable
through any number of `prune` passes — from prune's side the texture genuinely still has a
parent. Orphaned extension properties are dropped between two prunes. Measured: 0.82 MB of
arm texture shipped in every sniper build without it.

## Known gaps in the source export (reported, not fixed here)

- `lmg.glb` has no `reload_alt`; the hands carry `hand_lmg_reload_alt`.
- `shotgun.glb` has none of `pump`, `reload_single_shell`, `reload_complete`; the hands
  carry all three.

Both are the exporter gap described under SOURCE OF TRUTH in the export's own
`CODING_AGENT_NOTES.txt`. Nothing the game maps reaches either, and a test asserts that
stays true.

## `--genmipmap` here, forbidden in `tools/vegetation/ktx2.mjs`

Not an inconsistency. That bake supplies its own coverage-preserving mip chain because its
atlases are alpha-**tested** and a box filter thins the silhouette, which
`docs/08` §8 invariant 6 forbids. These textures are opaque or alpha-**blended**, where a
box filter is simply correct.
