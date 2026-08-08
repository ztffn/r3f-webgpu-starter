// The authored first-person rig: a hands skeleton and one equipped weapon, driven by
// two AnimationMixers in lockstep.
//
// Two mixers is the authored contract, not an implementation choice — the hand clips
// live in hands.glb namespaced per weapon, the weapon's own moving parts live in its
// own GLB, and the pair were keyed frame-for-frame against each other. This class owns
// the attach, the clip lookup, the rest pose and its rare fidget, the muzzle flash and
// the optic anchor.

import * as THREE from "three/webgpu";
import {
  handClipName,
  type WeaponPresentationDefinition,
} from "./WeaponPresentationDefinition.ts";
import { ATTACH_BONE, type LoadedRigAsset } from "./fpRigAssets.ts";

/** How long the muzzle flash stays visible. Matches the reference harness. */
const MUZZLE_FLASH_SECONDS = 0.06;

/** Crossfade between segments. Applied to both mixers so they cannot drift apart. */
const SEGMENT_FADE_SECONDS = 0.1;

/**
 * How long the weapon rests before it fidgets, and the spread on that.
 *
 * `idle` is NOT a loop. It is a rare "bored" spice clip over a static rest pose, and the
 * breathing the player actually sees between shots is procedural — the sway, look-lag
 * and recoil that WeaponPrototype applies to the rig group. Looping the clip instead
 * makes the weapon fidget without pause, which reads as a stuck animation.
 */
const IDLE_SPICE_MIN_SECONDS = 12;
const IDLE_SPICE_MAX_SECONDS = 26;

/**
 * The weapon's optic glass, measured from its own geometry.
 *
 * Derived rather than hardcoded on purpose. The proxy rig needed a separate bone-parented
 * `ScopeCam_Target` locator because its `SCOPE_Lens` was skinned, leaving the mesh origin
 * stuck at the rifle root and useless as a reference point. Every authored weapon lens is
 * a rigid node under its scope, so the node's own transform IS the physical reference —
 * and the disc's local bounds give the centre and radius that the PiP camera placement
 * and the lens shader's UV frame both need.
 */
export interface OpticAnchor {
  readonly lens: THREE.Mesh;
  /** Centre of the glass disc in the lens mesh's own local space. */
  readonly centre: THREE.Vector3;
  /** Half the disc's width — what the eyebox and reticle are scaled against. */
  readonly radius: number;
  /** The disc's flat axis, i.e. the optical axis. */
  readonly axis: "x" | "y" | "z";
}

interface EquippedWeapon {
  readonly asset: LoadedRigAsset;
  readonly definition: WeaponPresentationDefinition;
  readonly mixer: THREE.AnimationMixer;
  readonly optic: OpticAnchor | null;
  readonly muzzle: THREE.Object3D | null;
  readonly muzzleRollAxis: THREE.Vector3 | null;
  readonly muzzleBaseQuaternion: THREE.Quaternion | null;
}

/**
 * Find the optic lens and measure it.
 *
 * Matches the authored `_Lens` / `_Glass` suffix EXACTLY, with no tolerance for the
 * `.001` that Blender appends to a duplicate. That is not pedantry: fiftycal
 * deliberately carries a `Sniper_Glass.001` so its scope shader has something to
 * reference, and it is a 0.26-unit fragment rather than a lens plane. Accepting the
 * suffix here would hand that weapon a 0.13-radius "optic" and disagree with the
 * manifest the bake writes, which applies this same rule.
 */
function findOptic(scene: THREE.Object3D): OpticAnchor | null {
  let node: THREE.Object3D | null = null;
  scene.traverse((object) => {
    if (!node && /(_Lens|_Glass)$/.test(object.name)) node = object;
  });
  if (!node) return null;
  // Resolved through a possible Group for the same reason the muzzle flash is: a lens
  // authored with two material slots would otherwise report no optic at all, while the
  // bake's manifest — which reads the glTF node directly — still claims one.
  const mesh = firstMesh(node);
  if (!mesh?.geometry) return null;
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  if (!box) return null;
  const size = box.getSize(new THREE.Vector3());
  const spans: [("x" | "y" | "z"), number][] = [
    ["x", size.x],
    ["y", size.y],
    ["z", size.z],
  ];
  spans.sort((a, b) => a[1] - b[1]);
  const axis = spans[0][0];
  return {
    lens: mesh,
    centre: box.getCenter(new THREE.Vector3()),
    // The two non-flat spans are a disc's diameter; take the larger so a slightly
    // domed lens (the carbine's is 33 vertices and not perfectly planar) is covered.
    radius: Math.max(spans[1][1], spans[2][1]) / 2,
    axis,
  };
}

/**
 * First mesh at or beneath a node.
 *
 * glTF gives a node with more than one material slot a Group in three, with one child
 * Mesh per primitive. Reading `.geometry` straight off the node then finds nothing and
 * the feature disables itself in silence, which is exactly what happened to the muzzle
 * flash: every weapon's flash carries two slots ("muzzle1" and "muzzle2").
 */
function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  if ((root as THREE.Mesh).isMesh) return root as THREE.Mesh;
  let found: THREE.Mesh | null = null;
  root.traverse((object) => {
    if (!found && (object as THREE.Mesh).isMesh) found = object as THREE.Mesh;
  });
  return found;
}

/**
 * The flash's own roll axis, from its origin toward its vertex centroid.
 *
 * Computed from geometry rather than assumed to be local Y: artists reposition and
 * reorient these per weapon directly in Blender, and a fixed-axis assumption would need
 * a matching code edit every time somebody did. Accumulated across every mesh under the
 * node, because the flash is a two-slot Group and one slot is only half the shape.
 */
function muzzleRollAxis(root: THREE.Object3D): THREE.Vector3 {
  const centroid = new THREE.Vector3();
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    for (let i = 0; i < position.count; i += 1) {
      centroid.x += position.getX(i);
      centroid.y += position.getY(i);
      centroid.z += position.getZ(i);
    }
    count += position.count;
  });
  if (count > 0) centroid.divideScalar(count);
  return centroid.lengthSq() > 1e-12 ? centroid.normalize() : new THREE.Vector3(0, 1, 0);
}

export class FirstPersonWeaponRig {
  /** The hands scene. Mount this; the weapon rides inside it on the wrist bone. */
  readonly root: THREE.Object3D;

  private readonly handsMixer: THREE.AnimationMixer;
  private readonly hands: LoadedRigAsset;
  private readonly wristBone: THREE.Object3D;
  private equipped: EquippedWeapon | null = null;
  private handsAction: THREE.AnimationAction | null = null;
  private weaponAction: THREE.AnimationAction | null = null;
  private muzzleFlashRemaining = 0;
  /** True while the rig holds the authored rest pose rather than playing an action. */
  private atRest = false;
  private idleSpiceCountdown = 0;
  /** Set by the mixer's `finished` event; acted on at the top of the next update. */
  private restPending = false;

  constructor(hands: LoadedRigAsset) {
    this.hands = hands;
    this.root = hands.scene;
    const wrist = hands.scene.getObjectByName(ATTACH_BONE);
    if (!wrist) throw new Error(`hands rig has no "${ATTACH_BONE}" bone`);
    this.wristBone = wrist;
    this.handsMixer = new THREE.AnimationMixer(hands.scene);
    // The hands mixer is the timing authority for return-to-idle. Listening on one of
    // the two avoids firing the transition twice, and the hand clip is the one that is
    // never shorter than its weapon counterpart across the authored set.
    this.handsMixer.addEventListener("finished", this.handleFinished);
  }

  get optic(): OpticAnchor | null {
    return this.equipped?.optic ?? null;
  }


  /**
   * Attach a weapon to the wrist bone.
   *
   * No offset math: each weapon root's transform is already baked into R_wrist-local
   * space, so parenting it is the entire job. The Blender Z-up export does not intrude
   * here because the hands armature node carries the axis conversion and the 0.01 scale,
   * and everything under the wrist inherits both.
   */
  equip(asset: LoadedRigAsset, definition: WeaponPresentationDefinition): void {
    this.unequip();
    this.wristBone.add(asset.scene);

    const optic = findOptic(asset.scene);
    let muzzle: THREE.Object3D | null = null;
    asset.scene.traverse((object) => {
      // Exact match, never a substring: /muzzle/i also matches real hardware such as
      // Pistol_Muzzlebreak, which is a muzzle brake and not a flash mesh.
      if (!muzzle && /^muzzlemesh$/i.test(object.name)) muzzle = object;
    });
    // Hiding the node hides its children with it, so this is correct for the Group the
    // flash actually arrives as.
    if (muzzle) (muzzle as THREE.Object3D).visible = false;

    this.equipped = {
      asset,
      definition,
      mixer: new THREE.AnimationMixer(asset.scene),
      optic,
      muzzle,
      muzzleRollAxis: muzzle ? muzzleRollAxis(muzzle) : null,
      muzzleBaseQuaternion: muzzle ? (muzzle as THREE.Object3D).quaternion.clone() : null,
    };
    this.muzzleFlashRemaining = 0;
    this.atRest = false;
    this.restPending = false;
    // Raising the weapon is the authored way to arrive with it. Its finish drops the
    // rig into the rest pose, which is where everything else returns to as well.
    this.play(definition.segments.draw);
  }

  /**
   * Play one segment on both mixers, started together from zero.
   *
   * Both actions are reset and faded identically. They were keyed frame-for-frame, so
   * equal start time and equal playback rate is the whole synchronisation contract —
   * there is no per-frame correction, and adding one would mask a real desync.
   */
  play(segment: string): void {
    const equipped = this.equipped;
    if (!equipped) return;
    const handsClip = this.hands.clips.get(handClipName(equipped.definition.rigKey, segment));
    const weaponClip = equipped.asset.clips.get(segment);
    // A segment neither side can play is a no-op rather than a half-played action: the
    // shotgun's pump and the LMG's alternate reload exist in the hands and NOT in the
    // weapon file, and driving one of the pair alone animates hands around a static gun.
    if (!handsClip || !weaponClip) return;

    this.handsAction = this.startAction(this.handsMixer, handsClip, this.handsAction, false);
    this.weaponAction = this.startAction(equipped.mixer, weaponClip, this.weaponAction, false);
    this.atRest = false;
    // An explicitly started action supersedes a rest that has not run yet. Without this,
    // a weapon switch loses its draw: the outgoing weapon's `weapon_down` finishes and
    // arms the pending rest, the new weapon equips and starts `weapon_up`, and the stale
    // rest fires on the next update and cancels it — the weapon simply appears, already up.
    this.restPending = false;
  }

  /**
   * Hold the authored rest pose: the idle clip's first frame, paused.
   *
   * Nothing loops here. The visible life between actions comes from the procedural sway,
   * look-lag and recoil the host applies to the rig group, and this only supplies the
   * pose those act on — frame 0 of `idle`, which is where the spice animation starts and
   * ends and is therefore the pose the artist authored as neutral.
   */
  private enterRest(): void {
    const equipped = this.equipped;
    if (!equipped) return;
    const segment = equipped.definition.segments.idle;
    const handsClip = this.hands.clips.get(handClipName(equipped.definition.rigKey, segment));
    const weaponClip = equipped.asset.clips.get(segment);
    if (!handsClip || !weaponClip) return;
    this.handsAction = this.startAction(this.handsMixer, handsClip, this.handsAction, true);
    this.weaponAction = this.startAction(equipped.mixer, weaponClip, this.weaponAction, true);
    this.atRest = true;
    this.idleSpiceCountdown =
      IDLE_SPICE_MIN_SECONDS + Math.random() * (IDLE_SPICE_MAX_SECONDS - IDLE_SPICE_MIN_SECONDS);
  }

  /**
   * Start `clip`, crossfading from `previous` only when there is something to fade from.
   *
   * The guard is load-bearing, and its absence produced a very specific bug. The rest pose
   * and the idle fidget are the SAME clip, so `clipAction` hands back the SAME action
   * object for both — and `fadeIn` ramps weight up from zero. With no other action
   * contributing, that drops the skeleton to its BIND POSE for the length of the fade, at
   * the start of the fidget and again at its end. It reads as the animation snapping to a
   * completely unrelated frame rather than as a missing crossfade.
   *
   * The outgoing action is faded rather than stopped for the mirror-image reason: a
   * clamped or paused action still holds its last frame at full weight, and stopping it
   * drops that contribution instantly, leaving the fade-in ramping against the bind pose
   * again. Fading works on a paused action — weight interpolates on the mixer's clock,
   * not on the action's own time.
   */
  private startAction(
    mixer: THREE.AnimationMixer,
    clip: THREE.AnimationClip,
    previous: THREE.AnimationAction | null,
    hold: boolean
  ): THREE.AnimationAction {
    const next = mixer.clipAction(clip);
    const crossfade = previous !== null && previous !== next;
    if (crossfade) previous.fadeOut(SEGMENT_FADE_SECONDS);
    next.reset();
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
    next.setEffectiveWeight(1);
    if (crossfade) next.fadeIn(SEGMENT_FADE_SECONDS);
    next.play();
    // Paused after play() so the clip's time freezes while its weight still settles.
    next.paused = hold;
    return next;
  }

  /** Show the flash for a moment, rolled a random angle about its own authored axis. */
  triggerMuzzleFlash(): void {
    const equipped = this.equipped;
    if (!equipped?.muzzle || !equipped.muzzleRollAxis || !equipped.muzzleBaseQuaternion) return;
    equipped.muzzle.quaternion
      .copy(equipped.muzzleBaseQuaternion)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(equipped.muzzleRollAxis, Math.random() * Math.PI * 2)
      );
    equipped.muzzle.visible = true;
    this.muzzleFlashRemaining = MUZZLE_FLASH_SECONDS;
  }

  /**
   * Advance both mixers by the SAME delta.
   *
   * Takes the raw render delta, not the clamped simulation delta: presentation damping
   * and the mixer are deliberately outside the one-clock rule that weapons, sway and
   * projectiles share (docs/10 §3).
   */
  update(deltaSeconds: number, options: { idleSpiceAllowed?: boolean } = {}): void {
    if (this.restPending) {
      this.restPending = false;
      if (this.equipped) this.enterRest();
    }
    this.handsMixer.update(deltaSeconds);
    this.equipped?.mixer.update(deltaSeconds);
    if (this.muzzleFlashRemaining > 0) {
      this.muzzleFlashRemaining -= deltaSeconds;
      if (this.muzzleFlashRemaining <= 0 && this.equipped?.muzzle) {
        this.equipped.muzzle.visible = false;
      }
    }
    // The bored fidget is suppressed while aiming. It moves the whole weapon, so down a
    // scope it would walk the glass off the eye; playing it there needs the optic pinned
    // to the eye for the duration, which is deferred work rather than a tuning value.
    if (!this.atRest || options.idleSpiceAllowed === false) return;
    this.idleSpiceCountdown -= deltaSeconds;
    if (this.idleSpiceCountdown > 0) return;
    const equipped = this.equipped;
    if (equipped) this.play(equipped.definition.segments.idle);
  }

  /**
   * A finished one-shot settles back onto the authored rest pose — next frame.
   *
   * Deferred rather than done here: three dispatches `finished` from inside the mixer's
   * own update, while it is iterating its actions, and the rest pose reuses the very
   * action that just finished. Resetting it mid-dispatch mutates the list being walked.
   * One frame holding the clamped last frame costs nothing visible.
   *
   * Guarded on the action as well, and BOTH halves are load-bearing — keep them together.
   * `startAction` fades the outgoing action rather than stopping it, and three keeps a
   * faded action ENABLED, still advancing its own time and still able to dispatch, until
   * the fade interpolant runs out. So a segment replaced within SEGMENT_FADE_SECONDS of
   * its own natural end fires `finished` AFTER its replacement has started, and an
   * unguarded handler drops that replacement into the rest pose one frame in — a reload
   * keyed just after a shot simply never plays. Measured against this three build: a
   * 0.30 s clip replaced at 0.25 s still fires at 0.28 s, while the same swap at 0.10 s
   * fires nothing, so the window is exactly the fade.
   *
   * The bored fidget deliberately still passes the guard: the rest pose and the fidget
   * are the SAME clip, so `handsAction` is the action that finished, and that identity is
   * what returns the rig to rest at all.
   */
  private handleFinished = (event: { action: THREE.AnimationAction }): void => {
    if (event.action !== this.handsAction) return;
    this.restPending = true;
  };

  private unequip(): void {
    const equipped = this.equipped;
    if (!equipped) return;
    equipped.mixer.stopAllAction();
    equipped.mixer.uncacheRoot(equipped.asset.scene);
    this.wristBone.remove(equipped.asset.scene);
    if (equipped.muzzle) equipped.muzzle.visible = false;
    this.weaponAction = null;
    this.equipped = null;
  }

  /**
   * Detach everything this rig attached.
   *
   * Deliberately does NOT dispose geometry, materials or textures: the assets are cached
   * for the session by fpRigAssets, and a second mount reuses the very same objects.
   */
  dispose(): void {
    this.handsMixer.removeEventListener("finished", this.handleFinished);
    this.handsMixer.stopAllAction();
    this.handsMixer.uncacheRoot(this.hands.scene);
    this.unequip();
    this.handsAction = null;
  }
}
