# SpecialForcesSoldier Blender Pipeline — Runbook

Last updated: 2026-08-01. This document is the reference for anyone (human or Claude session) picking this asset back up later. It covers what's already been built, why it was built that way, and the exact procedure for adding more animations without repeating the mistakes made the first time through.

## 1. What this asset is

`SpecialForcesSoldier` is a modular character (separate gear meshes, not merged) built on a `mixamorig:`-named skeleton, originally from a webshop that claimed Mixamo compatibility. The end goal is a rig, driven by a large library of Mixamo animation clips, that can be exported/used in a Three.js multiplayer shooter (a separate codebase — not touched from this Blender session). The character holds a rifle that must track the right hand correctly across every animation.

## 2. Current file state

Working file: `SpecialForcesSoldier_AllAnims_v2.blend`, in the same folder as this runbook.

- Armature object: `Armature`, 67 bones, `mixamorig:` naming convention, object scale 1.0 (pre-baked by the original seller — this matters, see §5).
- 32 separate gear/body mesh objects, all parented to the armature (modular, not merged — do not merge them, that was an earlier dead end).
- 83 baked animation actions living directly on `Armature.animation_data` / `bpy.data.actions` (not NLA — see §6 for why NLA was abandoned). Each action is named after its source file, spaces replaced with underscores, `use_fake_user = True` so it survives being unlinked from the active slot.
- Two extra bones not in the original rig: `PalmSocket_L` and `PalmSocket_R`, each parented to the corresponding `mixamorig:*Hand` bone, positioned at the hand's tail. These have no animation of their own — they're static offsets that ride along with the hand bone in every action. `PalmSocket_R` is currently in use; `PalmSocket_L` exists but is untested (no left-hand prop yet).
- `Rifle` object: bone-parented (`parent_type = 'BONE'`, `parent_bone = "PalmSocket_R"`) to `PalmSocket_R`, **no keyframes of its own**. Current tuned offset (confirmed good by user, do not reset):
  - Location: `(-0.641, -0.026, 1.182)`
  - Rotation (Euler, degrees): `(-2.93°, 22.86°, 1.32°)`
  - Scale: `(1, 1, 1)`

  Because this is a rigid bone-parent with zero keyframes, this offset automatically applies in every one of the 83 actions with no extra work. If the rifle ever looks wrong in only a few specific animations, do not change this base offset — see §7.
- 12 Copy Rotation constraints on `Middle1-3` and `Pinky1-3` bones (both hands), targeting the corresponding `Ring1-3` bones (influence 0.9 for Middle, 0.75 for Pinky). This exists because Mixamo's auto-rigger only drives Thumb/Index/Ring — Middle and Pinky have no animation data of their own, so they're constrained to follow Ring instead of staying frozen in rest pose.
- Shoulder rest pose was cleared (`bpy.ops.pose.transforms_clear()`) — the original webshop file had `LeftShoulder`/`RightShoulder` bent off rest pose with no animation driving it, which is a bug in the pristine source file itself, not something animations caused.

Superseded/earlier files still in the folder (`SpecialForcesSoldier_T_fixed.blend`, `SpecialForcesSoldier_T_fresh.blend`) are intermediate stages — `AllAnims_v2` is the current source of truth and supersedes both.

## 3. The bug that ate several days, and why it happened

Every one of the first 83 imported animations showed severely twisted arms and the rifle clipping into the character's face. The cause was **not** the rig and **not** the rifle attachment — it was a rotation-retargeting bug in how animation data was copied from the Mixamo source files onto this rig.

The mistake: copying `rotation_quaternion` fcurve values directly from the source skeleton's bones onto this rig's matching-named bones, on the assumption that both skeletons use the same local bone-axis convention. They don't. Confirmed directly: this rig's `RightArm` local X-axis is roughly `(-0.047, -0.998, 0.035)`; the same bone in a fresh Mixamo import is roughly `(0, 0.043, 0.999)` — a completely different local frame. On top of that, the source animations are exported from a clean T-pose rest, while this rig's rest pose has the arms hanging ~38° down — so even a naive parent-relative fix (conjugating by the rest-pose difference) still failed, because the rest pose *shapes* differ, not just the axis labeling.

The fix is a full world-space retarget, computed per frame, root-to-leaf: for every bone, read its target world-space rotation from the source armature, then convert that into this rig's local bone space using this rig's own rest pose (not the source's). See §4 for the working code.

## 4. Adding new Mixamo animations — step by step

This is the procedure to follow for any new animation clips dropped into the `mixamo_anims` folder later. It reuses code already validated in this session (exact world-space quaternion match, dot product = 1.0, checked across 12 major bones and 5 sample frames per clip on 8 diverse test animations, plus a zero-issue NaN/extreme-value sweep across all 83 existing actions).

### 4.1 One-time setup per Blender session

```python
import bpy, mathutils

our_arm = bpy.data.objects["Armature"]

# Topologically sorted (root->leaf) bone order for our rig — build once.
bone_order = []
visited = set()
def add_bone(b, seen):
    if b.name in seen: return
    if b.parent and b.parent.name not in seen:
        add_bone(b.parent, seen)
    seen.add(b.name)
    bone_order.append(b.name)
for b in our_arm.data.bones:
    add_bone(b, visited)

def find_context():
    win = bpy.context.window_manager.windows[0]
    area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
    region = next(r for r in area.regions if r.type == 'WINDOW')
    return win, area, region

def build_retarget_data(src_arm):
    shared = set(b.name for b in our_arm.data.bones) & set(b.name for b in src_arm.data.bones)
    order = [bn for bn in bone_order if bn in shared]
    rest_parent_relative = {}
    rest_world = {}
    for bn in order:
        b = our_arm.data.bones[bn]
        this_world = (our_arm.matrix_world @ b.matrix_local)
        rest_world[bn] = this_world.to_quaternion()
        if b.parent and b.parent.name in shared:
            parent_world = (our_arm.matrix_world @ b.parent.matrix_local)
            rest_parent_relative[bn] = (parent_world.inverted() @ this_world).to_quaternion()
        else:
            rest_parent_relative[bn] = rest_world[bn]
    hips_src_rest_q = (src_arm.matrix_world @ src_arm.data.bones["mixamorig:Hips"].matrix_local).to_quaternion()
    hips_loc_correction = rest_world["mixamorig:Hips"].inverted() @ hips_src_rest_q
    return order, rest_parent_relative, rest_world, hips_loc_correction

def retarget_current_frame(src_arm, order, rest_parent_relative, rest_world):
    src_world_q = {}
    for bn in order:
        src_world_q[bn] = (src_arm.matrix_world @ src_arm.pose.bones[bn].matrix).to_quaternion()
    our_world_q = {}
    out_local = {}
    for bn in order:
        b = our_arm.data.bones[bn]
        target_world_q = src_world_q[bn]
        if b.parent and b.parent.name in rest_parent_relative and b.parent.name in our_world_q:
            parent_world_q = our_world_q[b.parent.name]
            needed = parent_world_q.inverted() @ target_world_q
            out_local[bn] = rest_parent_relative[bn].inverted() @ needed
        else:
            out_local[bn] = rest_world[bn].inverted() @ target_world_q
        our_world_q[bn] = target_world_q
    return out_local
```

### 4.2 Per-file import + bake

```python
import os, time

folder = "/Users/steffen/Downloads/mixamo_anims"

def fcount(a):
    try:
        return len(a.layers[0].strips[0].channelbags[0].fcurves)
    except Exception:
        return 0

def process_file(fname, action_name):
    before_objs = set(bpy.data.objects.keys())
    before_actions = set(bpy.data.actions.keys())
    filepath = os.path.join(folder, fname)
    win, area, region = find_context()
    with bpy.context.temp_override(window=win, area=area, region=region):
        bpy.ops.import_scene.fbx(filepath=filepath)
    new_objs = [bpy.data.objects[n] for n in (set(bpy.data.objects.keys()) - before_objs)]
    new_actions = [bpy.data.actions[n] for n in (set(bpy.data.actions.keys()) - before_actions)]
    src_arm = next((o for o in new_objs if o.type == 'ARMATURE'), None)
    if src_arm is None:
        return {"error": "no armature imported", "file": fname}

    real_action = max(new_actions, key=fcount) if new_actions else None
    if real_action is None or fcount(real_action) < 50:
        for o in new_objs: bpy.data.objects.remove(o, do_unlink=True)
        for a in new_actions: bpy.data.actions.remove(a)
        return {"error": "no real action found", "file": fname}

    frs = real_action.frame_range
    f_start, f_end = int(frs[0]), int(frs[1])
    order, rest_parent_relative, rest_world, hips_loc_correction = build_retarget_data(src_arm)

    src_arm.animation_data_create()
    src_arm.animation_data.action = real_action
    if real_action.slots:
        src_arm.animation_data.action_slot = real_action.slots[0]

    scale_ratio = src_arm.scale[0] / our_arm.scale[0] if our_arm.scale[0] != 0 else src_arm.scale[0]

    old = bpy.data.actions.get(action_name)
    if old: bpy.data.actions.remove(old)
    new_act = bpy.data.actions.new(action_name)
    new_act.use_fake_user = True
    our_arm.animation_data_create()
    our_arm.animation_data.action = new_act

    for f in range(f_start, f_end + 1):
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        local_rots = retarget_current_frame(src_arm, order, rest_parent_relative, rest_world)
        hips_loc = (hips_loc_correction.to_matrix() @ src_arm.pose.bones["mixamorig:Hips"].location) * scale_ratio
        for bn, q in local_rots.items():
            pb = our_arm.pose.bones[bn]
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=f)
        hpb = our_arm.pose.bones["mixamorig:Hips"]
        hpb.location = hips_loc
        hpb.keyframe_insert("location", frame=f)
        if new_act.slots and our_arm.animation_data.action_slot is None:
            our_arm.animation_data.action_slot = new_act.slots[0]

    for o in new_objs: bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.actions.remove(real_action)
    return {"file": fname, "action": action_name, "frames": f_end - f_start + 1, "bones": len(order)}
```

Run it per new file: `process_file("New Clip.fbx", "New_Clip")`. Runtime is roughly 0.3s per file for a ~90-frame clip — fast enough to batch all new files in one go.

After baking, always run `bpy.ops.outliner.orphans_purge(do_recursive=True)` and check for leftover `*|mixamo.com|Layer0*` placeholder actions or stray `Armature.00N` objects — these are FBX-importer leftovers that should be cleaned up, not left in the file.

## 5. Verification checklist (do this every time, not just once)

This project's history included several false "it's fixed" claims caught by re-checking. Don't skip this step for new batches:

1. **Sweep every baked action for NaN/Inf and absurd values** (catches silent math errors):
   ```python
   import math
   issues = []
   for act in bpy.data.actions:
       for strip in act.layers[0].strips:
           for cb in strip.channelbags:
               for fc in cb.fcurves:
                   for kp in fc.keyframe_points:
                       v = kp.co[1]
                       if math.isnan(v) or math.isinf(v):
                           issues.append((act.name, fc.data_path))
   ```
2. **Re-import a handful of the new source FBX files fresh as ground truth**, and compare world-space bone direction against the baked result at several sample frames (start/25%/50%/75%/end), across at least both forearms, both upper arms, spine, and both legs. Use dot product of a consistent local direction vector (e.g. bone Y-axis) transformed to world space — should be ~1.0. Do **not** trust name-based matching to find the "ground truth" action among existing actions in the file (this caused a false failure once already — always identify the freshly-imported action by diffing `bpy.data.actions` before/after import, never by searching existing action names, since multiple unrelated actions can share fcurve counts).
3. **Visual spot check**: scrub 2-3 of the new clips in the viewport if the screenshot/render tools are cooperating.

## 6. Known Blender 5.x pitfalls (don't rediscover these)

- **Slotted actions**: setting `AnimData.action` alone does not drive bones. You must also set `AnimData.action_slot` — for a freshly created action, the slot only exists after the first `keyframe_insert()` call, so bind it right after the first frame's keyframes are inserted (`if new_act.slots and our_arm.animation_data.action_slot is None: ...`).
- **NLA strip `action_slot` bindings are unreliable across save/reload** in this Blender build. Don't use NLA for this pipeline — bind actions directly to `AnimData.action`/`action_slot` instead, which survives reload reliably.
- **FBX import context error**: `bpy.ops.import_scene.fbx` calls `bpy.ops.object.mode_set` internally, which needs a real window/area/region context, not just an active object. Always wrap the import in `bpy.context.temp_override(window=..., area=..., region=...)` using a `VIEW_3D` area (see `find_context()` above), or it throws `RuntimeError: Context missing active object`.
- **The FBX importer creates a placeholder action** per import, usually named like `Armature.00N|mixamo.com|Layer0`, with 0 fcurves. The real animation lives in a separate action with hundreds of fcurves. Always pick the action with the most fcurves among the newly-created ones (diffed before/after import), never assume it's whichever one is currently assigned to `AnimData.action`.
- **Hips location scale**: every fresh FBX import gets its own armature at object scale 0.01 (raw centimeter data), while this rig is object scale 1.0 (pre-baked by the seller). Always multiply the source Hips location by `src_arm.scale[0] / our_arm.scale[0]`, not a hardcoded 0.01 — if a future source file comes in at a different scale, a hardcoded constant will silently produce wrong root motion.

## 7. Rifle / prop attachment notes

- The rifle is bone-parented to `PalmSocket_R` with zero keyframes — this is intentional and is what makes the current grip transfer to all 83 (and any future) animations automatically. Do not add keyframes to the `Rifle` object; if it ever needs per-animation adjustment, that should be a small **additional** offset layered on top (e.g. a driver or a second empty), not a replacement of the base parent-bone offset.
- If a future weapon or prop needs to sit in the left hand, `PalmSocket_L` already exists (same setup, parented to `mixamorig:LeftHand`) but has never been tested with an actual prop — expect to tune its offset the same way `PalmSocket_R` was tuned.
- A single rigid offset can't perfectly fit every hand pose across 80+ animations. If the grip looks wrong in only one or two specific extreme poses (prone is the most likely offender), that's expected — don't change the base offset chasing it. Handle those as isolated per-action fixes if and when they're visibly bad enough to matter.
- The eventual runtime IK phase (in the Three.js codebase, not this file) is why both palm sockets exist in the first place — they're meant to be usable as IK target/effector references in code later.

## 8. Open items / not yet done

- `PalmSocket_L` has no prop attached or tested yet.
- No per-animation override system exists yet for edge-case grip poses (see §7) — not built because nothing has demonstrated the need yet.
- Export pipeline from this `.blend` into the Three.js game (glTF export, animation clip naming/splitting for the engine, etc.) has not been addressed in this session at all — that's a separate future task.
