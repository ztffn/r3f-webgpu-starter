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

## Weapon bob — the one idea, and three wrong models on the way to it

The central idea, which I did not have on the first attempt and which everything else falls
out of: **accumulate bob phase from DISTANCE TRAVELLED, not from elapsed time.**

```js
this.bobPhase = (this.bobPhase + (speed * dt) / metresPerCycle) % 1;
```

That one line does two unrelated jobs at once, which is why it feels like the right shape
rather than a trick:

1. **It is frame-rate independent by construction.** There is no `dt` term left to get
   wrong, because `speed * dt` IS the distance. Walk ten metres and you are at the same
   point in the gait whether you did it in 300 frames or 1400. I verified it: at 144 Hz and
   240 Hz over identical ground the phase agrees to six decimals (0.736842 both).
2. **It locks the gait to stride instead of to the clock.** Slowing down stretches the
   cycle rather than merely shrinking the bob. A time-driven bob has to be told about speed
   separately and then gets the relationship wrong; a distance-driven one never has to be
   told at all.

The engine survey is worth recording because it shows this is the road everyone walked.
Quake (`cl_bobcycle 0.6`) and Half-Life (`cl_bobcycle 0.8`) use a **fixed period** — running
bobs BIGGER, never faster, which is the opposite failure and is why later engines dropped it.
Quake III and Doom 3 use a **constant cadence per movement state** (`pm_walkbob 0.3`,
`pm_runbob 0.4`), so stride length falls out of speed and cadence is bounded structurally.
Half-Life 2 is **distance-driven, exactly this scheme**. So the mechanism was never the
question; the constants were.

### Wrong model 1 — fixed stride

`metresPerCycle` constant at 1.9 m. Every extra metre per second became cadence and none of
it became reach: **6.32 footfalls/s at 6 m/s**, roughly double a real sprint. The user's
description was "baby steps", which is exactly right and exactly the arithmetic.

Half-Life 2 runs the same scheme over a **7.32 m stride** and never shuffles. Mine was a
quarter of that. The scheme was never wrong; the constant was too small. Fixed by lengthening
stride toward a sprint value (1.9 → 3.6 m, following Doom 3, where stride grows only 18%
while speed rises 57% — most of the extra speed SHOULD become cadence, just not all of it),
plus a hard cadence clamp so no future speed change can quietly reintroduce it. 3.53
footfalls/s at 6 m/s.

### Wrong model 2 — the follow filter, and why removing it made things worse

I had run the whole figure through an exponential follow so the weapon would lag the body.
Measured what it actually cost, at rate 12:

| component | frequency at 3.2 m/s | travel surviving |
|---|---|---|
| lateral `sin θ` | 1.68 Hz | 21.00 mm of 28 authored |
| vertical | 6.74 Hz | **2.31 mm of 10 authored** |

So I removed it — and the user immediately said "way faster and snappier, not in a good way,
even tinier feet, no weight to it." Correct, and the most useful single piece of feedback of
the session: **I had removed the crutch, not the defect.** The filter was rounding off a
sharpness that should never have existed.

The thing I under-appreciated at the time is that a lowpass on a two-frequency figure does
not *attenuate* it. Unequal gain **and** unequal phase across the two components means it
**deforms** the shape — the figure-eight comes out squashed vertically and skewed. And the
escape route is closed: to keep the vertical within 5% you need λ ≥ 64 s⁻¹, which passes 66%
of the error every frame at 60 fps. **Any filter fast enough to leave the bob intact is doing
nothing at all.** There is no good value; the mechanism is wrong.

The rule, once I had it: **the bob is a displacement you author, not a signal you chase.** A
follow filter exists to manufacture lag from an input you do not control — the mouse. The bob
is already exactly the motion you want. Shipped engines never mix the two: Source computes
look lag first and *adds* bob on top (`CalcViewModelLag` then `AddViewModelBob`, in that
order); Doom 3 adds three independent terms; DarkPlaces puts them behind separate cvars
entirely. Weight belongs to look-lag, which I had at a 58 ms half-life against Source's own
140 ms, clamped to 6 mm against 8 cm. Retuned there instead.

### Wrong model 3 — I doubled the frequency twice

The one that made me laugh. The vertical was `-|sin(2θ)|`. Rectification **already** doubles
frequency, so rectifying an already-doubled wave doubles twice: **4× the stride rate, not
2×**. 6.74 Hz at walking pace, four vertical humps per two footfalls. That is the "tinier
feet" literally, in arithmetic.

It also carries a **cusp at every footfall** — a hard corner where the derivative flips sign.
That is the "snappy". And it was what the filter had been rounding off, which is why removing
the filter made a bug I hadn't found yet suddenly visible.

Quake III avoids this by folding the rectification into the phase mapping rather than applying
it on top — it maps each half-cycle to 0→π so `sin` is already non-negative and its `fabs` is
a no-op. Pick one doubling mechanism, not both.

The classic figure-eight is **unrectified `sin(2θ)`**: smooth, one dip per footfall, and it
actually swings both ways. `|sin|` is always positive, so a rectified weapon can only ever
rise — it is a bounce, not a figure-eight.

### What the tests ended up asserting

Two lessons here, both worth keeping.

**Assert the invariant, not the derived value.** The frame-rate test first compared rendered
OUTPUT across rates and failed — but the failure was my test harness, not the code:
`for (t = 0; t < seconds; t += dt)` accumulates float error and runs a different number of
steps per rate, so the rates travelled different distances (12.907 m at 30 Hz vs 12.800 at
144). Fixed step count, and then assert **phase** exactly (that is the guarantee) rather than
output.

**A test that would have caught the whole mess.** The regression test now asserts that the
authored amplitude is the amplitude the player actually gets — both axes within 2% of what
the table says. Under the filter that test fails instantly at 27% on the vertical. I had a
tuning UI exposing numbers that were fiction and no test connecting a dialled value to a
rendered one.

Three bugs in this section, and every one was caught by measuring output rather than reading
code. Compare the sprint pose below, which had no such test and shipped broken.

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
