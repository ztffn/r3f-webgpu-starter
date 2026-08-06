// One animated soldier in the world, driven by pose facts.
//
// The single character host both consumers share: the local third-person view
// feeds it MotorState, RemotePlayers feeds it interpolated snapshots — the
// same CharacterPose either way, which is the design. Owns the cloned model,
// the CharacterAnimator, and the CharacterAimRig with its mandatory frame
// order (beginFrame -> mixer.update -> aimRig.update, docs/10 §3). It owns no
// gameplay truth: position, yaw, pitch and stance arrive as data every frame.

import * as THREE from "three/webgpu";
import { CharacterAnimator } from "./CharacterAnimator.ts";
import { CharacterAimRig, type AimRigProfile } from "./CharacterAimRig.ts";
import { localizeVelocity, type LocomotionSample } from "../../character/characterClips.ts";
import { instantiateSoldier, type SoldierAsset } from "./soldierAssets.ts";
import type { MotorState, PlayerStance } from "../../motor/MotorTypes.ts";

/** Everything a frame of character presentation needs, derivable from a local
 * MotorState and from a remote snapshot alike. Position is the FEET. */
export interface CharacterPose {
  positionX: number;
  positionY: number;
  positionZ: number;
  yawRadians: number;
  pitchRadians: number;
  velocityX: number;
  velocityZ: number;
  stance: PlayerStance;
  grounded: boolean;
  sprinting: boolean;
  aiming: boolean;
}

/** One scratch pose per consumer, filled every frame. */
export function createCharacterPose(): CharacterPose {
  return {
    positionX: 0,
    positionY: 0,
    positionZ: 0,
    yawRadians: 0,
    pitchRadians: 0,
    velocityX: 0,
    velocityZ: 0,
    stance: "stand",
    grounded: true,
    sprinting: false,
    aiming: false,
  };
}

/**
 * The one place pose facts are copied out of a motor-shaped state, so a field
 * added to CharacterPose cannot be threaded through one consumer and silently
 * stay stale in the other. Typed structurally so presentation never imports
 * gameplay truth beyond the fields it reads.
 */
export function fillCharacterPose(
  pose: CharacterPose,
  position: { x: number; y: number; z: number },
  yawRadians: number,
  pitchRadians: number,
  state: Pick<MotorState, "velocity" | "stance" | "grounded" | "sprinting" | "aiming">
): void {
  pose.positionX = position.x;
  pose.positionY = position.y;
  pose.positionZ = position.z;
  pose.yawRadians = yawRadians;
  pose.pitchRadians = pitchRadians;
  pose.velocityX = state.velocity.x;
  pose.velocityZ = state.velocity.z;
  pose.stance = state.stance;
  pose.grounded = state.grounded;
  pose.sprinting = state.sprinting;
  pose.aiming = state.aiming;
}

/** Runtime bone names — the glTF export strips Blender's ':' from
 * "mixamorig:Spine" et al. Spine1 sits between spine and chest as an unlisted
 * intermediate, which the rig's chain walk handles. */
const SOLDIER_AIM_PROFILE: AimRigProfile = {
  bones: {
    spine: "mixamorigSpine",
    chest: "mixamorigSpine2",
    neck: "mixamorigNeck",
    head: "mixamorigHead",
  },
  yawWeights: { spine: 0.2, chest: 0.35, neck: 0.15, head: 0.3 },
  pitchWeights: { spine: 0.15, chest: 0.4, neck: 0.15, head: 0.3 },
  limits: {
    spine: { yaw: [-0.35, 0.35], pitch: [-0.3, 0.3] },
    chest: { yaw: [-0.5, 0.5], pitch: [-0.5, 0.5] },
    neck: { yaw: [-0.4, 0.4], pitch: [-0.35, 0.35] },
    head: { yaw: [-1.0, 1.0], pitch: [-0.7, 0.7] },
  },
  headAimBias: 0.8,
  damping: {
    lookHalfLife: 0.08,
    aimHalfLife: 0.05,
    weightAttackHalfLife: 0.08,
    weightReleaseHalfLife: 0.15,
  },
};

/** Aim-channel weight while merely looking around (not ADS): spine and chest
 * carry this fraction of the pitch so look-around is a leaning body rather
 * than a floating head. Tuning of the same species as the profile above. */
const LOOK_TORSO_AIM_FRACTION = 0.35;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class CharacterView {
  /** Caller parents this into the scene and never touches its transform. */
  readonly group = new THREE.Group();

  private readonly animator: CharacterAnimator;
  private readonly aimRig: CharacterAimRig | null;
  private readonly rootQuat = new THREE.Quaternion();
  private readonly sample: { -readonly [K in keyof LocomotionSample]: LocomotionSample[K] } = {
    speed: 0,
    forward: 0,
    left: 0,
    stance: "stand",
    grounded: true,
    sprinting: false,
    aiming: false,
  };

  constructor(asset: SoldierAsset) {
    const model = instantiateSoldier(asset);
    // The model is authored facing +Z; the motor's yaw 0 faces -Z. The half
    // turn is baked into the child so the group's yaw stays in motor terms.
    model.rotation.y = Math.PI;
    this.group.add(model);

    this.animator = new CharacterAnimator(model, [...asset.animations], asset.clipSpeeds);

    let skeleton: THREE.Skeleton | null = null;
    model.traverse((object) => {
      const skinned = object as THREE.SkinnedMesh;
      if (skeleton === null && skinned.isSkinnedMesh) skeleton = skinned.skeleton;
    });
    let rig: CharacterAimRig | null = null;
    if (skeleton !== null) {
      try {
        rig = new CharacterAimRig(SOLDIER_AIM_PROFILE, skeleton);
      } catch (error) {
        // A renamed bone should not cost the whole character — just the aim.
        console.warn("aim rig disabled:", error);
      }
    }
    this.aimRig = rig;
  }

  /**
   * Starts, or ends, this character's death.
   *
   * Aliveness comes from the caller's authoritative health, never from whether a
   * death event arrived: a dropped packet would otherwise leave a corpse walking.
   * The event only chooses which fall plays.
   */
  get isDead(): boolean {
    return this.animator.isDead;
  }

  setDead(dead: boolean, clipName: string): void {
    if (dead) this.animator.die(clipName);
    else this.animator.revive();
  }

  /** The mandatory order: beginFrame, mixer, aim rig (docs/10 §3). Raw render
   * delta on purpose — the rig clamps internally. */
  update(deltaSeconds: number, pose: CharacterPose): void {
    this.group.position.set(pose.positionX, pose.positionY, pose.positionZ);
    this.group.rotation.y = pose.yawRadians;

    // A dead body is still receiving snapshots and still has a pose, but its
    // aim rig must not keep tracking: a corpse whose spine follows a look angle
    // is the uncanny half of this that reads worst.
    if (this.animator.isDead) {
      this.animator.update(deltaSeconds, this.sample);
      return;
    }

    localizeVelocity(pose.velocityX, pose.velocityZ, pose.yawRadians, this.sample);
    this.sample.speed = Math.hypot(pose.velocityX, pose.velocityZ);
    this.sample.stance = pose.stance;
    this.sample.grounded = pose.grounded;
    this.sample.sprinting = pose.sprinting;
    this.sample.aiming = pose.aiming;

    if (this.aimRig === null) {
      this.animator.update(deltaSeconds, this.sample);
      return;
    }

    this.aimRig.beginFrame();
    this.animator.update(deltaSeconds, this.sample);

    // Group yaw is the only root rotation (the +Z fixup lives on the child),
    // so the root world quaternion is analytic — no matrix-world walk.
    this.rootQuat.setFromAxisAngle(WORLD_UP, pose.yawRadians + Math.PI);
    this.aimRig.setRootWorldQuaternion(
      this.rootQuat.x,
      this.rootQuat.y,
      this.rootQuat.z,
      this.rootQuat.w
    );
    // CharacterPose cannot express an aim that deviates from body yaw, so the
    // rig's root-local aim is exactly yaw 0 with the pose's pitch — the value
    // CharacterAimPresentationAdapter would compute, minus the identity round
    // trip. When a real world-space aim direction rides the pose (body lag,
    // networked weapon aim), reintroduce the adapter here: docs/10 §2 names it
    // the sole gameplay-to-render conversion point.
    this.aimRig.setLook(0, pose.pitchRadians, 1);
    // The aim channel is what drives spine and chest. Committed on ADS; a
    // fraction otherwise, so plain look-around still carries some torso pitch
    // instead of a floating head on a rigid body.
    this.aimRig.setAim(0, pose.pitchRadians, pose.aiming ? 1 : LOOK_TORSO_AIM_FRACTION);
    this.aimRig.update(deltaSeconds);
  }

  /** Hiding also drives the aim offsets to identity — a half-applied offset
   * pops visibly when the character returns (aim rig spec §10). */
  setVisible(visible: boolean): void {
    if (this.group.visible === visible) return;
    this.group.visible = visible;
    if (!visible) this.aimRig?.resetOffsets();
  }

  dispose(): void {
    this.animator.dispose();
    this.group.removeFromParent();
    // Geometry and materials are shared with the template; only the clone's
    // scene-graph membership is ours to release.
  }
}
