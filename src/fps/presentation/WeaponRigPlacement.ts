// Where the first-person rig sits this frame: the authored pose, the ADS alignment, and
// the additive sway, look-lag, recoil and bob layered on top.
//
// Extracted from WeaponPrototype's frame callback because the ORDER of these operations is
// load-bearing in two places and neither was testable inside a 400-line useFrame. Both are
// asserted in tests/fps/weapon-rig-placement.test.ts, so a future rearrangement fails
// loudly rather than showing up as a scope that no longer lines up with the eye.

import * as THREE from "three/webgpu";
import type { OpticAnchor } from "./FirstPersonWeaponRig.ts";
import type { PosePlacement, WeaponPose } from "./weaponPoseStore.ts";

/**
 * Everything that moves the weapon this frame, in one mutable record.
 *
 * Mutable and pre-allocated, like `createFiringTimelineFrame`: this is read once per frame
 * on the render path, and an object literal per frame is exactly the allocation the rest of
 * this subsystem goes to trouble to avoid.
 *
 * Angles are RADIANS unless the field says degrees. The pose table stores degrees because a
 * person types those into a slider; everything computed stays in radians.
 */
export interface WeaponRigPlacementFrame {
  /** The authored placement for the equipped weapon. */
  pose: WeaponPose;
  /** 0 at the hip, 1 fully in the sprint pose. */
  sprintBlend: number;
  /** 0 hipfire, 1 fully aimed. The DAMPED presentation blend, never gameplay progress. */
  adsBlend: number;
  /**
   * The equipped weapon's glass, or null.
   *
   * Presence changes what `pose.ads` MEANS. With an optic the glass is aligned to the eye
   * and `pose.ads` is eye relief on top; without one there is no anchor to align to and
   * `pose.ads` is the entire placeholder raise.
   */
  optic: OpticAnchor | null;
  swayXMetres: number;
  swayYMetres: number;
  swayYawRadians: number;
  swayPitchRadians: number;
  lookLagXMetres: number;
  lookLagYMetres: number;
  recoilYawRadians: number;
  recoilPitchRadians: number;
  bobXMetres: number;
  bobYMetres: number;
  bobZMetres: number;
  bobRollDegrees: number;
  bobYawDegrees: number;
  bobPitchDegrees: number;
}

const NEUTRAL_POSE: WeaponPose = {
  hip: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 },
  sprint: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 },
  ads: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 },
};

export function createWeaponRigPlacementFrame(): WeaponRigPlacementFrame {
  return {
    pose: NEUTRAL_POSE,
    sprintBlend: 0,
    adsBlend: 0,
    optic: null,
    swayXMetres: 0,
    swayYMetres: 0,
    swayYawRadians: 0,
    swayPitchRadians: 0,
    lookLagXMetres: 0,
    lookLagYMetres: 0,
    recoilYawRadians: 0,
    recoilPitchRadians: 0,
    bobXMetres: 0,
    bobYMetres: 0,
    bobZMetres: 0,
    bobRollDegrees: 0,
    bobYawDegrees: 0,
    bobPitchDegrees: 0,
  };
}

const lerp = THREE.MathUtils.lerp;
const degToRad = THREE.MathUtils.degToRad;

/**
 * Rebuilds the rig's transform from scratch each frame.
 *
 * Stateless apart from its scratch vectors, which exist so the render path allocates
 * nothing. Rebuilding rather than accumulating is deliberate: the mixers have already
 * moved the skeleton by the time this runs, and an incremental transform would leave ADS
 * aligned to the pose of the previous frame.
 */
export class WeaponRigPlacement {
  private readonly offset = new THREE.Vector3();
  private readonly aimOffset = new THREE.Vector3();
  private readonly opticLocal = new THREE.Vector3();

  /**
   * Place `rig` in `camera`'s frame.
   *
   * `camera` supplies the eye position and orientation only; it is never moved. The player
   * camera not moving for ADS is the whole reason this class exists — terrain controls and
   * the main view stay stable while only the weapon interpolates.
   */
  apply(rig: THREE.Object3D, camera: THREE.Object3D, frame: WeaponRigPlacementFrame): void {
    const pose = frame.pose;
    rig.position.copy(camera.position);
    rig.quaternion.copy(camera.quaternion);

    // hip -> sprint, then -> ads. Aiming and sprinting are mutually exclusive in the motor,
    // so layering ADS last means it wins the frame a player aims out of a sprint.
    const running = (field: keyof PosePlacement) =>
      lerp(pose.hip[field], pose.sprint[field], frame.sprintBlend);
    const aimed = (field: keyof PosePlacement) =>
      lerp(running(field), pose.ads[field], frame.adsBlend);

    // INVARIANT 1 — the authored tilt must be applied before the TRANSLATION below.
    //
    // The rig is rotated about its own origin, and the lens is a descendant, so a tilt
    // applied after the weapon has been moved onto the eye swings the glass straight back
    // off it. Applied first, the offset is computed along the tilted axes and the
    // alignment stays exact — which is what lets an iron sight nose down for free.
    //
    // It is NOT, despite what the original comment here claimed, the tilt-versus-optic
    // MEASUREMENT order that matters. `localToWorld` and `worldToLocal` run through the
    // same rig transform, so its rotation cancels and `opticLocal` is the glass's
    // rig-local position whatever the rig is doing. Swapping those two changes nothing —
    // verified by mutation, after the comment survived a review by sounding right. The
    // measurement is left here because it reads in the order the operations happen.
    //
    // Sway and recoil deliberately stay AFTER the translation: those rotate the weapon
    // about where it is held, which is a different thing from how it is held.
    rig.rotateX(degToRad(aimed("pitch")));
    rig.rotateY(degToRad(aimed("yaw")));
    rig.rotateZ(degToRad(aimed("roll")));
    rig.updateMatrixWorld(true);

    if (frame.optic) {
      // The glass's own local centre, pushed to world through the lens node. The lens is a
      // rigid child of the animated scope, so this tracks the scope through recoil and
      // reload without needing a separate authored locator.
      frame.optic.lens.localToWorld(this.opticLocal.copy(frame.optic.centre));
      rig.worldToLocal(this.opticLocal);
      this.aimOffset.copy(this.opticLocal).negate();
      this.aimOffset.x += pose.ads.x;
      this.aimOffset.y += pose.ads.y;
      this.aimOffset.z += pose.ads.z;
    } else {
      this.aimOffset.set(pose.ads.x, pose.ads.y, pose.ads.z);
    }

    // INVARIANT 2 — position takes the hip -> sprint step ONLY. Its ADS step is the lerp
    // toward an `aimOffset` that already carries `pose.ads`, so routing it through
    // `aimed()` here would apply the aimed offset TWICE and pull the weapon past the eye
    // at full ADS.
    this.offset.set(running("x"), running("y"), running("z"));
    this.offset.lerp(this.aimOffset, frame.adsBlend);
    rig.translateX(this.offset.x + frame.swayXMetres + frame.lookLagXMetres + frame.bobXMetres);
    rig.translateY(this.offset.y + frame.swayYMetres + frame.lookLagYMetres + frame.bobYMetres);
    rig.translateZ(this.offset.z + frame.bobZMetres);

    rig.rotateY(frame.swayYawRadians + frame.recoilYawRadians);
    rig.rotateX(frame.swayPitchRadians + frame.recoilPitchRadians);
    rig.rotateZ(degToRad(frame.bobRollDegrees));
    rig.rotateY(degToRad(frame.bobYawDegrees));
    rig.rotateX(degToRad(frame.bobPitchDegrees));
    rig.updateMatrixWorld(true);
  }
}
