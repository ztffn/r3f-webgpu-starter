import { Bone, MathUtils, Quaternion, Skeleton, Vector3 } from "three/webgpu";
import { normalizeYaw } from "./CharacterAimPresentationAdapter.ts";

export type AimRigBoneName = "spine" | "chest" | "neck" | "head";

export interface BoneWeights {
  readonly spine: number;
  readonly chest: number;
  readonly neck?: number;
  readonly head: number;
}

export interface AimRigProfile {
  readonly bones: { readonly spine: string; readonly chest: string; readonly neck?: string; readonly head: string };
  readonly yawWeights: BoneWeights;
  readonly pitchWeights: BoneWeights;
  readonly limits: Record<AimRigBoneName, { readonly yaw: readonly [number, number]; readonly pitch: readonly [number, number] }>;
  readonly headAimBias: number;
  readonly damping: {
    readonly lookHalfLife: number;
    readonly aimHalfLife: number;
    readonly weightAttackHalfLife: number;
    readonly weightReleaseHalfLife: number;
  };
}

interface RigBoneState {
  readonly key: AimRigBoneName;
  readonly bone: Bone;
  readonly pathFromPrevious: readonly Bone[];
  readonly animatedQuat: Quaternion;
  readonly currentOffset: Quaternion;
  readonly targetOffset: Quaternion;
}

const DT_MAX = 0.1;
const ROOT_UP = new Vector3(0, 1, 0);
const ROOT_RIGHT = new Vector3(1, 0, 0);
const ROOT_FORWARD = new Vector3(0, 0, 1);

function halfLifeAlpha(halfLife: number, dt: number): number {
  if (halfLife <= 0) return 1;
  return 1 - Math.exp((-Math.LN2 * dt) / halfLife);
}

function dampWeight(current: number, target: number, attack: number, release: number, dt: number): number {
  const halfLife = target > current ? attack : release;
  return MathUtils.lerp(current, target, halfLifeAlpha(halfLife, dt));
}

/**
 * Procedural post-mixer character rig. Angles are radians in render-root local
 * space: zero faces +Z, positive yaw turns toward +X, positive pitch looks up.
 * Root roll is excluded by the presentation adapter before values arrive here.
 */
export class CharacterAimRig {
  residualYaw = 0;

  private lookYaw = 0;
  private lookPitch = 0;
  private lookWeight = 0;
  private aimYaw = 0;
  private aimPitch = 0;
  private aimWeight = 0;
  private currentLookWeight = 0;
  private currentAimWeight = 0;

  private readonly states: readonly RigBoneState[];
  private readonly leadingPath: readonly Bone[];
  private readonly rootWorld = new Quaternion();
  private readonly aimFrameWorld = new Quaternion();
  private readonly parentWorld = new Quaternion();
  private readonly inverse = new Quaternion();
  private readonly deltaRoot = new Quaternion();
  private readonly deltaWorld = new Quaternion();
  private readonly yawQuat = new Quaternion();
  private readonly pitchQuat = new Quaternion();
  private readonly lookQuat = new Quaternion();
  private readonly aimQuat = new Quaternion();
  private readonly headQuat = new Quaternion();
  private readonly headForward = new Vector3();
  private readonly rootForward = new Vector3();
  private targetYaw = 0;
  private targetPitch = 0;
  private readonly profile: AimRigProfile;

  constructor(profile: AimRigProfile, skeleton: Skeleton) {
    this.profile = profile;
    const ordered: Array<{ key: AimRigBoneName; name: string }> = [
      { key: "spine", name: profile.bones.spine },
      { key: "chest", name: profile.bones.chest },
      ...(profile.bones.neck ? [{ key: "neck" as const, name: profile.bones.neck }] : []),
      { key: "head", name: profile.bones.head },
    ];
    const found = ordered.map(({ key, name }) => {
      const bone = skeleton.bones.find((candidate) => candidate.name === name);
      if (!bone) throw new Error(`Aim rig bone not found: ${key} (${name})`);
      return { key, bone };
    });

    this.leadingPath = this.pathFromAncestor(null, found[0].bone);
    this.states = found.map(({ key, bone }, index) => ({
      key,
      bone,
      pathFromPrevious: index === 0 ? [] : this.pathFromAncestor(found[index - 1].bone, bone),
      animatedQuat: bone.quaternion.clone(),
      currentOffset: new Quaternion(),
      targetOffset: new Quaternion(),
    }));
  }

  /** Restore the last pure animated pose before AnimationMixer writes this frame. */
  beginFrame(): void {
    for (const state of this.states) state.bone.quaternion.copy(state.animatedQuat);
  }

  setLook(yaw: number, pitch: number, weight: number): void {
    this.lookYaw = normalizeYaw(yaw);
    this.lookPitch = pitch;
    this.lookWeight = MathUtils.clamp(weight, 0, 1);
  }

  setAim(yaw: number, pitch: number, weight: number): void {
    this.aimYaw = normalizeYaw(yaw);
    this.aimPitch = pitch;
    this.aimWeight = MathUtils.clamp(weight, 0, 1);
  }

  /** World orientation of the render root; primitive setter avoids retained scene references. */
  setRootWorldQuaternion(x: number, y: number, z: number, w: number): void {
    this.rootWorld.set(x, y, z, w).normalize();
  }

  /** Capture mixer output, damp offsets, compose once, then propagate root to leaf. */
  update(dtSeconds: number): void {
    const dt = Math.min(Math.max(dtSeconds, 0), DT_MAX);
    for (const state of this.states) state.animatedQuat.copy(state.bone.quaternion);

    this.currentLookWeight = dampWeight(
      this.currentLookWeight,
      this.lookWeight,
      this.profile.damping.weightAttackHalfLife,
      this.profile.damping.weightReleaseHalfLife,
      dt
    );
    this.currentAimWeight = dampWeight(
      this.currentAimWeight,
      this.aimWeight,
      this.profile.damping.weightAttackHalfLife,
      this.profile.damping.weightReleaseHalfLife,
      dt
    );

    // Build the aim frame from root heading and WORLD up. The full rootWorld is
    // still used for bone-parent conversion below, but root roll/slope pitch
    // must not tilt the gameplay horizon.
    this.rootForward.copy(ROOT_FORWARD).applyQuaternion(this.rootWorld);
    this.rootForward.y = 0;
    if (this.rootForward.lengthSq() < Number.EPSILON) this.rootForward.copy(ROOT_FORWARD);
    else this.rootForward.normalize();
    this.aimFrameWorld.setFromAxisAngle(
      ROOT_UP,
      Math.atan2(this.rootForward.x, this.rootForward.z)
    );

    this.parentWorld.copy(this.rootWorld);
    for (const bone of this.leadingPath) this.parentWorld.multiply(bone.quaternion);

    let appliedYaw = 0;
    for (const state of this.states) {
      for (const bone of state.pathFromPrevious) this.parentWorld.multiply(bone.quaternion);

      this.setTargetAngles(state.key);
      const limit = this.profile.limits[state.key];
      const yaw = MathUtils.clamp(this.targetYaw, limit.yaw[0], limit.yaw[1]);
      const pitch = MathUtils.clamp(this.targetPitch, limit.pitch[0], limit.pitch[1]);
      appliedYaw += yaw;

      this.makeRootDelta(yaw, pitch, this.deltaRoot);
      // Parent-space offset derivation:
      // qOffset = inverse(qParentWorld) * qDeltaWorld * qParentWorld.
      this.deltaWorld.copy(this.aimFrameWorld).multiply(this.deltaRoot);
      this.inverse.copy(this.aimFrameWorld).invert();
      this.deltaWorld.multiply(this.inverse);
      this.inverse.copy(this.parentWorld).invert();
      state.targetOffset.copy(this.inverse).multiply(this.deltaWorld).multiply(this.parentWorld);

      const halfLife =
        state.key === "neck" || (state.key === "head" && this.currentAimWeight < 0.5)
          ? this.profile.damping.lookHalfLife
          : this.profile.damping.aimHalfLife;
      state.currentOffset.slerp(state.targetOffset, halfLifeAlpha(halfLife, dt)).normalize();

      // The offset is expressed in parent space, so it pre-multiplies the pure
      // animated local pose. Damping the composed pose would blur locomotion.
      state.bone.quaternion.copy(state.currentOffset).multiply(state.animatedQuat);
      this.parentWorld.multiply(state.bone.quaternion);
    }

    const desiredYaw =
      this.currentAimWeight > 0.001
        ? this.aimYaw * this.currentAimWeight
        : this.lookYaw * this.currentLookWeight;
    this.residualYaw = normalizeYaw(desiredYaw - appliedYaw);
  }

  /** LOD/off-screen policy hook: restore pure animation and clear frozen offsets. */
  resetOffsets(): void {
    for (const state of this.states) {
      state.currentOffset.identity();
      state.targetOffset.identity();
      state.bone.quaternion.copy(state.animatedQuat);
    }
    this.currentLookWeight = 0;
    this.currentAimWeight = 0;
    this.residualYaw = 0;
  }

  private setTargetAngles(key: AimRigBoneName): void {
    if (key === "spine" || key === "chest") {
      this.targetYaw = this.aimYaw * this.currentAimWeight * this.profile.yawWeights[key];
      this.targetPitch = this.aimPitch * this.currentAimWeight * this.profile.pitchWeights[key];
      return;
    }
    if (key === "neck") {
      this.targetYaw = this.lookYaw * this.currentLookWeight * (this.profile.yawWeights.neck ?? 0);
      this.targetPitch = this.lookPitch * this.currentLookWeight * (this.profile.pitchWeights.neck ?? 0);
      return;
    }

    this.makeRootDelta(this.lookYaw, this.lookPitch, this.lookQuat);
    this.makeRootDelta(this.aimYaw, this.aimPitch, this.aimQuat);
    this.headQuat.copy(this.lookQuat).slerp(
      this.aimQuat,
      MathUtils.clamp(this.currentAimWeight * this.profile.headAimBias, 0, 1)
    );
    this.headForward.copy(ROOT_FORWARD).applyQuaternion(this.headQuat).normalize();
    const channelWeight = Math.max(this.currentLookWeight, this.currentAimWeight);
    this.targetYaw =
      Math.atan2(this.headForward.x, this.headForward.z) *
      channelWeight *
      this.profile.yawWeights.head;
    this.targetPitch =
      Math.asin(MathUtils.clamp(this.headForward.y, -1, 1)) *
      channelWeight *
      this.profile.pitchWeights.head;
  }

  private makeRootDelta(yaw: number, pitch: number, target: Quaternion): void {
    this.yawQuat.setFromAxisAngle(ROOT_UP, yaw);
    // With authored +Z forward, negative rotation around +X looks upward.
    this.pitchQuat.setFromAxisAngle(ROOT_RIGHT, -pitch);
    target.copy(this.yawQuat).multiply(this.pitchQuat);
  }

  private pathFromAncestor(ancestor: Bone | null, descendant: Bone): readonly Bone[] {
    const reversed: Bone[] = [];
    let cursor = descendant.parent;
    while (cursor && cursor !== ancestor) {
      if ((cursor as Bone).isBone) reversed.push(cursor as Bone);
      cursor = cursor.parent;
    }
    if (ancestor && cursor !== ancestor) {
      throw new Error(`Aim rig bones are not one root-to-leaf chain near ${descendant.name}`);
    }
    reversed.reverse();
    return reversed;
  }
}
