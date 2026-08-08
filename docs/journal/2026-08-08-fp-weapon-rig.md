# Replacing the proxy first-person rig — journal

**Feature:** fp-weapon-rig
**Date:** 2026-08-08
**Status:** raw

## Goal

Kill `testmodels/fps_rig.glb` — one proxy model shared by all four weapons, with animation
"segments" addressed as NUMBERS sliced out of a single 27-second timeline — and put the
authored hands-and-weapons rig in its place. Ten weapons, each with its own model, its own
moving parts, and named clips. Two AnimationMixers in lockstep instead of one mixer with
numeric indices.

Downstream reason: iron sights and a holographic red dot are next, and a red dot can't be a
second picture-in-picture render — the world behind the glass has to be the same world at
the same scale. So a main-camera FOV aiming path is coming, and I needed to know what optic
each weapon actually carries before sizing that work.

## What the assets turned out to be

Spent the first stretch reading GLB JSON chunks directly rather than trusting
`CODING_AGENT_NOTES.txt`. Notes were good — better than most — but wrong in three places
and stale in a fourth.

Wrote a dependency-free GLB inspector (scratchpad, not committed) that dumps nodes, meshes,
animations and, critically, each animation's real keyframe time range from the sampler
input accessors' min/max. That last bit is the only way to see whether the manual "keyframe
rebase" step landed. It had — every clip starts at t=0.

**The scope anchor, which I'd been warned was the highest-risk thing.** The proxy needed
BOTH a `SCOPE_Lens` mesh (material swap) and a separate bone-parented `ScopeCam_Target`
locator (PiP camera + ADS alignment). The new `sniper.glb` has no locator. Turned out not to
matter, and for a good reason: the proxy needed the locator only because its `SCOPE_Lens` was
SKINNED, so the mesh origin stayed pinned at the rifle root and was useless as a reference.
Every authored lens is a rigid node under its scope, so the node's own transform IS the
physical reference. `Sniper_Glass` is a 17-vertex flat disc, span 4.2591 × 4.2591 × 0 on
local Z, centre (0, 0, 1.0596), radius 2.1296. Measure the bounding box at load and you get
the PiP anchor and the lens UV frame for free. Deleted `LENS_MIN_X` / `LENS_MIN_Y` /
`LENS_DIAMETER` (proxy-specific baked constants) in favour of a `lensFrame` uniform carrying
(centre.x, centre.y, radius). The lens SHADER is untouched.

**Optics per weapon**, which answers how much of the FOV path is needed:

| | weapons |
|---|---|
| magnified PiP | `sniper` |
| authored emissive red dot | `carbine`, `grenadelauncher` |
| no optic node at all | `ak`, `smg`, `pistol`, `lmg`, `shotgun` |
| scope body, no usable glass | `fiftycal` |

`Carbine_Lens` is 33 verts, span 2.8831 × 2.8831 × 0.344 (slightly domed), black base
colour, `KHR_materials_emissive_strength`, alpha blend, and a real **680×680 redDot
texture**. The notes warn `redDot.png` "has no size and cannot be exported" — stale, it
exported fine in both files. So the red dot is already authored and needs no second render.

`fiftycal` carries a `Sniper_Glass.001` that the docs say is deliberate contamination for
its scope shader. It's a 0.2579-span fragment, not a lens. Bake and runtime must BOTH match
the `_Lens`/`_Glass` suffix exactly with no `.001` tolerance, or they disagree — I wrote the
runtime regex loose first and caught it against the manifest.

**Three real asset defects:**

1. `sniper.glb` alone ships a second full copy of the hands — `Hands_Armature`, 49 bones,
   the skinned `Hands_Mesh`, and 8.31 MB of arm textures — as a second scene root. 21.6 MB
   vs carbine's 11.5. The reference harness does `weaponRoot = gltf.scene` and parents the
   whole thing to the wrist, so equipping the sniper there should hang a second pair of arms
   in bind pose off the player's wrist. I generalised from this one file at first and told
   the user "every weapon GLB does this" — wrong, only the sniper does. Corrected.
2. `lmg.glb` has no `reload_alt`.
3. `shotgun.glb` has none of `pump`, `reload_single_shell`, `reload_complete` — its entire
   pump-and-reload cycle. The hands carry all of these; only the weapon side is missing.
   Classic Blender NLA/Actions export gap, which the notes themselves describe.

Also: hands and weapon clips match durations frame-for-frame, which confirms the lockstep
design. And gameplay reload is a flat 4.2 s while authored reloads are sniper 1.63,
carbine/pistol 2.20, LMG 5.77 — the LMG gets cut 1.57 s short, which is exactly the failure
docs/10 §7 says the 4.2 was chosen to avoid. Left alone; reload time is claimed to the
server so it's a balance change, not a presentation one.

## The prepare step

`tools/fphands/prepare-fphands.mjs`, `npm run prepare:fphands`. 150.2 MB → 49.4 MB (67%),
Draco geometry + KTX2 UASTC/Zstd textures at 1024px, plus an `index.json` manifest.

Two gltf-transform traps, both of which looked like they'd worked:

- **`detach()` doesn't remove a subtree, and `dispose()` re-parents children.** Detaching
  `Hands_Armature` left all 49 bones and the skinned mesh alive, and `prune` then correctly
  refused to remove them because a live `Skin` still cited them. Log said "dropped stray
  root", scene listed only the weapon, and 2.18 MB of arm textures still shipped. Fix:
  collect the subtree first, dispose every node, then dispose boneless skins.
- **Disposing a Material does not dispose its extension properties.** The stripped hands
  material's `KHR_materials_specular` node outlived it and kept `armsmoothness` (0.82 MB)
  reachable through any number of prune passes — from prune's side the texture genuinely
  still had a parent. Verified by printing `texture.listParents()`: `Root, Specular`. Fix:
  drop orphaned extension properties between two prunes.

Both were only caught because the script re-reads its own output and asserts. Checking the
source document can't see what the pipeline did to it.

Validation refuses on missing CORE clips (idle/weapon_up/weapon_down/primary action) and on
un-rebased keyframes, but only WARNS on documented-but-absent segments and records them as
`missingSegments` — otherwise the LMG and shotgun gaps would block the eight good weapons
over clips nothing calls.

`--genmipmap` is used here and forbidden in `tools/vegetation/ktx2.mjs`. Not an
inconsistency: that bake supplies a coverage-preserving chain because its atlases are
alpha-TESTED and a box filter thins the silhouette; these are opaque or alpha-BLENDED.

KTX2 in-browser transcode was flagged as unverified in the impostor plan. It works — verified
in Chrome, textures render.

## The rig runtime

`fpRigAssets.ts` (cached loads through the committed Draco + Basis decoders, load-time clip
assertions) and `FirstPersonWeaponRig.ts` (two mixers, wrist attach, rest pose, muzzle flash,
optic anchor). Presentation definition rewritten to keyed-by-rig-weapon named clips.

Attach is just parenting — every weapon root's transform is already baked into `R_wrist`-local
space. The Z-up/Y-up split between the files doesn't intrude, because `Hands_Armature` carries
both the axis conversion and the 0.01 unit scale and everything under the wrist inherits them.
Also killed `MODEL_SCALE = 3`; the authored armature arrives in metres.

**`muzzlemesh` is a `Group`, not a `Mesh`.** Two material slots (`muzzle1`, `muzzle2`) → glTF
gives it one child Mesh per primitive. Reading `.geometry` off the node found nothing, the
geometry-derived roll axis came back null, and `triggerMuzzleFlash` returned early — the flash
never fired, silently. Only found it by querying the live scene from the browser console.
Optic lookup now resolves through a possible Group for the same reason.

**The magenta patch** I chased for a while was `src/fps/TestTargets.tsx:167`, a pre-existing
`0xff00ff` debug marker. Not mine. Wasted maybe twenty minutes.

## Poses, and the tuning loop

Proxy's `HIP_OFFSET` (0.24, -0.37, -0.56) was tuned against a 3×-scaled model with a
different internal origin. Carried over it put the hands below the bottom of the frame — a
rifle held by nobody. Measured the rig in eye space: weapon spans 1.616 m in Z, butt 36 cm
behind the eye, muzzle 1.25 m forward; lens centre 17.7 cm above the eye, which ADS cancels.

I tuned a hip pose by eye and the user rightly said guessing from screenshots was the wrong
loop. Built a **Weapon pose** dev-console tab instead: per weapon, hip/sprint/ADS, position
and rotation, Hold ADS and Hold sprint toggles (you can't hold pointer lock and drag a
slider), persistence, and a paste-back-as-source block. That turned out to be the single
most valuable thing built today — every subsequent fix came from the user tuning and
reporting, not from me guessing.

Persistence started as `sessionStorage`. That's per-TAB and discarded on close. I closed
tabs myself during testing. Reads exactly like the values being overwritten. Now
`localStorage`.

**ADS blend rate was a single global constant** (`AIM_RESPONSE = 18`, ~56 ms lag) applied to
every weapon, smearing the authored per-weapon ADS timings into each other — the M4's 0.18 s
and the sniper's 0.22 s felt identical because both carried the same 56 ms tail. Now a RATIO
against each weapon's own enter/exit seconds, anchored at 4 so the sniper reproduces the old
18.2 and the change is purely the spread. First attempt used 5, which sped up every weapon —
user caught it as a blanket feel change I'd described as a fix.

## Weapon bob — three wrong models in a row

Built it, user said "run animation feels too fast, like baby steps." Went through three
iterations, each wrong for a different reason. Worth recording all three.

**v1: fixed stride.** `metresPerCycle` constant at 1.9 m, so every extra m/s became cadence
and none became reach. 6.32 footfalls/s at 6 m/s, roughly double a real sprint. Fixed by
lengthening stride toward a sprint value → 3.53/s.

**v2: removed the follow filter.** Measured that the filter ate the vertical: at rate 12 the
lateral kept 21.00 mm of 28 authored, the vertical kept **2.31 mm of 10**. Frequency-selective,
because the vertical runs faster. So any vertical amplitude tuned would have been fiction.
Removed it. User: "way faster and snappier, not in a good way, even tinier feet, no weight."
Correct — I'd removed the crutch, not the defect.

**v3, after research:** two more bugs underneath.
- `|sin(2θ)|` is **4× the stride rate, not 2×** — rectification already doubles, so I doubled
  twice. 6.74 Hz at walking pace. That's the "tinier feet" literally. It also has a **cusp at
  every footfall** — that's the "snappy", and it's what the filter had been rounding off.
  Classic figure-eight is unrectified `sin(2θ)`.
- Stride was ~4× too short. Half-Life 2 uses this exact distance-driven scheme with a
  **7.32 m stride** and never shuffles. Scheme was never wrong; constant was too small. Now
  1.9 → 3.6 m following Doom 3 (stride +18% while speed +57%), with a hard cadence clamp.
- Filter question settled by sources: Source computes look-lag FIRST then **adds** bob;
  DarkPlaces puts them behind separate cvars. Bob is a displacement you author, not a signal
  you chase. Weight comes from look-lag — mine was at a 58 ms half-life vs Source's 140 ms,
  and clamped to 6 mm vs 8 cm. Retuned.

Two more caught by my own tests: the amplitude floor (0.35, Quake III's rule for creeping)
was applying at a standstill so the bob never settled; and my gait expression
`max(g, g * sprintBlend)` can never exceed `g`, so the sprint input did nothing. Gait now
derives from speed alone, which is more honest anyway.

Research (subagent, ~520k tokens across two rounds) also produced the only citable procedural
sprint pose in existence — OpenSpades, read from source: roll −31.5°, pitch +17.2°, yaw
−5.7°, translation 23 cm across / 15 cm down / 5 cm back. Shape is **roll-dominant,
yaw-minimal, translation-large**. The agent caught itself having inverted the vertical axis
and corrected three of its own earlier estimates that were 3–5× off. User's tuned poses lean
the other way (LMG yaw 21.5 against roll 24.5, nearly equal). Reported, not changed.

## Sprint — one state written twice

User: "sprint pose identical to run pose." Found `motorPose={motorDemo ? motorPose : null}`
(DF2Scene:1174) — without `&motor=1` there's no motor, so my `motorPose !== null &&
motorPose.sprinting` pinned `sprintBlend` at 0 for ever. The pose was being applied at weight
zero, indistinguishable from not existing.

Bolted on a speed threshold (>4.5 m/s = sprinting) so it'd work without a motor. **Made it
worse**: now the POSE thought you were sprinting while `handlingContext.sprinting` (which
gates firing) still required a motor. User: "run and sprint both use sprint settings, and we
can fire while sprinting now." Two conditions for one concept, disagreeing.

Real fix: resolve sprint ONCE per frame into a single value, read by both the pose blend and
the firing refusal. Speed proxy deleted entirely — it conflates running with sprinting, which
is the exact distinction the sprint pose exists to draw.

## ADS sensitivity

`setOpticState` was called with `scopeFov.current`, a single global seeded from the sniper's
5.5°, for every weapon. Aiming the Glock or SAW — no lens at all — cut pointer speed by
roughly the factor an 8× scope would. Now passes camera FOV when the weapon has no optic, so
the ratio is 1. Deliberate per-weapon multipliers deferred at user's request.

## Result

- Suite 400 → 419, typecheck clean throughout.
- Assets 150.2 → 49.4 MB; 52 MB committed under `public/assets/weapons/`.
- Proxy rig gone. Ten weapons load, animate on two lockstep mixers, muzzle-flash, and pose
  per weapon at hip/sprint/ADS.
- Scope PiP works on the derived anchor: reticle, zero/wind status inside the glass,
  rangefinder. Verified in browser.
- Debug keys 5-0 reach the six weapons with no gameplay definition (presentation only).
- docs/10 §11 (as-built) and §12 (deferred roadmap) written; CLAUDE.md updated.

## Open

Everything in docs/10 §12. The ones I'd want picked up first:

- Shot feedback (view shake / FOV punch) — deferred to next phase by the user. Constraint is
  written down: the camera IS the authoritative aim source, so shake must land after the aim
  sample and after the scope pass.
- Per-weapon ADS sensitivity multipliers; three separate mechanisms want folding into one table.
- The three source-asset defects above — need fixing in the Blender file, not in code.
- Every weapon's bob starts identical; six weapons on placeholder poses; scope eye relief
  untuned (glass fills ~¾ of screen height).
- Tuning lives in one browser's localStorage until pasted into source. Fine for one person.
- Audio never touched (`AUDIO_SYNC_HANDOVER.md`).

## Note to self

The pattern today: I'd build something, claim it worked because it typechecked and the values
were in the table, and the user would find it broken in thirty seconds. The sprint pose
shipped "ready to tune" with a blend weight that could never leave zero. The muzzle flash
shipped unable to fire. Both would have been caught by asserting the OUTPUT rather than the
wiring — which is exactly what caught all three bob bugs, because those had tests. Measure
the thing the player sees, not the thing you wrote.
