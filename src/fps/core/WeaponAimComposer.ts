import * as THREE from "three/webgpu";

const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);
const LOCAL_X = new THREE.Vector3(1, 0, 0);
const LOCAL_Y = new THREE.Vector3(0, 1, 0);

/** Allocation-free presentation-edge composition for local weapon angular offsets. */
export class WeaponAimComposer {
  private readonly baseQuaternion = new THREE.Quaternion();
  private readonly yawQuaternion = new THREE.Quaternion();
  private readonly pitchQuaternion = new THREE.Quaternion();

  composeQuaternion(
    base: THREE.Quaternion,
    yawRadians: number,
    pitchRadians: number,
    target: THREE.Quaternion
  ): THREE.Quaternion {
    this.yawQuaternion.setFromAxisAngle(LOCAL_Y, yawRadians);
    this.pitchQuaternion.setFromAxisAngle(LOCAL_X, pitchRadians);
    return target.copy(base).multiply(this.yawQuaternion).multiply(this.pitchQuaternion).normalize();
  }

  directionFromQuaternion(quaternion: THREE.Quaternion, target: THREE.Vector3): THREE.Vector3 {
    return target.copy(LOCAL_FORWARD).applyQuaternion(quaternion).normalize();
  }

  offsetDirection(
    direction: THREE.Vector3Like,
    yawRadians: number,
    pitchRadians: number,
    target: THREE.Vector3
  ): THREE.Vector3 {
    target.set(direction.x, direction.y, direction.z);
    if (target.lengthSq() <= Number.EPSILON) target.copy(LOCAL_FORWARD);
    else target.normalize();
    this.baseQuaternion.setFromUnitVectors(LOCAL_FORWARD, target);
    this.composeQuaternion(this.baseQuaternion, yawRadians, pitchRadians, this.baseQuaternion);
    return this.directionFromQuaternion(this.baseQuaternion, target);
  }
}

