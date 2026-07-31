# Isolated animated weapon prototype

## Goal

Provide a disposable `?scene=weapon` first-person test scene using the local
`testmodels/sniper_fps_animation.glb`. It must let us judge the authored
hands/rifle animation against the existing DF2 terrain without changing the
working `?scene=scope` optic prototype.

## Design

The prototype continues to compose `DF2Scene`, so terrain, grass, lighting,
fog, and player controls remain the authoritative environment. `App` selects a
weapon-prototype mode from the URL. In that mode a `WeaponPrototype` owns one
GLTF load, a `THREE.AnimationMixer`, and a group held in camera space. Its one
exported timeline (`Scene`) is an eight-action reel, so the prototype splits it
at its authored keyframe gaps and plays each segment once on `1`–`8`; it is not
treated as an idle loop. The loaded meshes live on
the weapon layer so a later scope capture can exclude the whole rig exactly as
the current PiP implementation does.

The production-shaped render order is world → optional scope target → weapon
overlay. The player camera renders layer 0 with the terrain's normal 60°
vertical FOV. A 40° weapon camera renders only layer 1 after a depth clear, with
a 0.01 m near plane, so the arms/rifle stay sharp and never clip world geometry.
The scope camera also renders only layer 0. This deliberately leaves one final
composition point for a future shared tone map/color grade: world-only effects
such as depth of field run before the weapon overlay, while any scope-specific
look remains inside the lens material rather than becoming a second fullscreen
post-process pass.

There is deliberately no fire/reload state machine, weapon gameplay, asset
copy, or permanent licensing decision in this spike. The model stays at its
existing local path and can be removed cleanly. A later integration will first
identify the animated model's optical centre, then attach the PiP scope camera
and lens to that transform; it must not inherit the temporary scope model.

## Verification

`?scene=weapon` loads the rifle and hands without replacing `?scene=scope`,
the `Scene` clip visibly loops, the weapon follows look movement but is excluded
from any future scope render pass, and `npm run typecheck` plus `npm run build`
pass.
