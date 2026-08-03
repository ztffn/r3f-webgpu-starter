# SpecialForcesSoldier — Handover

Location: `assets/3d/characters/player1/` (r3f-webgpu-starter)
Last updated: 2026-08-01

This is the orientation doc for this folder. For the deep pipeline/technical reference (how the rig was fixed, how to add more animations, Blender gotchas), see `SpecialForcesSoldier_Pipeline_Runbook.md` in this same folder — that document is still fully valid and this handover doesn't replace it.

## Which file to use

This folder has two `.blend` files. Use one, ignore the other:

- **`SpecialForcesSoldier_AllAnims_v2_.blend` — use this one.** This is the fixed, clean, current file: correct rig (shoulders cleared, palm sockets added), 83 animations retargeted with the corrected world-space algorithm (not the broken direct-copy version), rifle bone-parented and tuned to `PalmSocket_R`.
- `SpecialForcesSoldier_T_fixed.blend` — **do not use.** This is an early intermediate file from before the rig was rebuilt clean and before the retargeting bug was fixed. It's kept around only as history.

You correctly called it: the 83-clip "all anims" pack is a bit of a grab-bag (some names are near-duplicates, a couple are oddly long, naming isn't fully curated) — but it's mechanically correct. Per your call, this is the only animation pack we're using; the raw FBX files in the sibling `Rifle 8-Way Locomotion Pack` folder are **not** integrated and shouldn't be treated as ready to use (see below).

**One thing I can't fully confirm right now:** the `.blend` file's size/timestamp in this folder doesn't exactly match the final verified save from the fix session (106 MB / 13:32 in the original working folder vs. 116 MB / 12:27 here), which suggests this copy may have been taken at a slightly different point than my last save. The exported `SpecialForcesSoldier.glb` in this same folder, by contrast, **is** directly verified — I checked its contents right after the retargeting fix and confirmed all 83 clips are present, correctly named, with no corrupt/NaN data. So: **treat the GLB as the known-good source of truth.** Before doing further work in the `.blend`, reconnect Blender and sanity-check it — open the file and confirm `bpy.data.actions` has 83 entries and the rifle's local rotation on `PalmSocket_R` is roughly `(-2.93°, 22.86°, 1.32°)` (see runbook §2 for the exact values). If that doesn't match, re-derive from the GLB or flag it before continuing.

## Files in this folder

| File | What it is |
|---|---|
| `SpecialForcesSoldier_AllAnims_v2_.blend` | Working file — rig + 83 animations. Use this for further Blender edits. |
| `SpecialForcesSoldier.glb` | Exported binary glTF — mesh, skeleton, and all 83 animation clips baked in. This is what actually loads in Three.js. |
| `SpecialForcesSoldier_animations.txt` | Plain-text list of all 83 clip names + frame counts + durations, matching exactly what `gltf.animations[i].name` will be after `GLTFLoader`. |
| `SpecialForcesSoldier_Pipeline_Runbook.md` | Full technical reference: rig details, the retargeting bug and fix, code to bake more animations later, verification checklist, Blender 5.x gotchas. |
| `SpecialForcesSoldier_T_fixed.blend` | Superseded — do not use. |
| `textures/` | Source texture files. |

## Known issue: the GLB is 290 MB — and it's the textures, not the animations

Checked this directly by parsing the GLB's buffer views:

- **Textures: 279.3 MB (96% of the file)** — 21 images, all raw 4K PNGs embedded uncompressed. The worst offenders: `gear_Normal_OpenGL` (30 MB), `body_Normal_OpenGL` (24 MB), `gear_Base_color` (21 MB), `headgear_Normal_OpenGL` (20 MB), plus two full sets of rifle textures (~17 MB and ~16 MB each) — normal maps, roughness, metallic, and base color for gear/body/headgear/optic/rifle×2, each at full 4K resolution as lossless PNG.
- **Animations: 4.4 MB (1.5%)** — your instinct was right, this was never the problem. 83 clips at 30fps is genuinely tiny.
- **Geometry: 2.7 MB (1%)** — also not an issue, 31 modular mesh primitives is lightweight.

So the entire size problem is texture encoding, not content. Recommended next pass, roughly in order of impact:

1. **Downres.** Very few of these need to stay at 4K for a third-person or even close-up view — 2K (or 1K for smaller gear pieces) will look fine and cuts pixel count by 4x (16x for 1K). Normal/roughness/metallic maps in particular are usually fine well below diffuse resolution.
2. **Compress texture format.** Base color maps don't need alpha or lossless precision — re-export as JPEG or, better, convert the whole GLB's textures to **KTX2/Basis Universal** (via `gltf-transform` or Blender's own KTX2 export option) — GPU-compressed textures load faster and use far less VRAM in the browser, not just less disk space.
3. **Consider Draco or meshopt on geometry** too while you're at it, though at 2.7 MB it's not urgent.
4. Optionally split the GLB into a static mesh+skeleton file plus separate per-animation-group GLBs if you ever want to lazy-load animation sets instead of shipping all 83 clips on first load — not necessary at 4.4 MB of anim data, but worth knowing the export supports it (see runbook's notes on `export_animation_mode` and NLA tracks).

None of this requires re-touching the rig or animations — it's a texture re-export pass on top of the current, correct `.blend`/GLB.

## Quick start for a fresh session

1. Open `SpecialForcesSoldier_AllAnims_v2_.blend` in Blender.
2. Verify action count and rifle offset as noted above before assuming it's current.
3. For anything involving adding new animations, fixing the rig further, or understanding *why* things are set up this way — read `SpecialForcesSoldier_Pipeline_Runbook.md` first. It has working, tested code for the retargeting bake.
4. For loading in the Three.js project, `SpecialForcesSoldier.glb` + `SpecialForcesSoldier_animations.txt` are the two files that matter; the `.blend` is source, not runtime.
