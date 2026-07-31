import * as THREE from "three/webgpu";

const FALLBACK_FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * Undamped world-space gameplay aim. Shooting and targeting read this state;
 * presentation may derive a smoothed/clamped copy but never writes one back.
 */
export class AuthoritativeAimState {
  readonly origin = new THREE.Vector3();
  readonly direction = new THREE.Vector3(0, 0, -1);
  revision = 0;

  set(origin: THREE.Vector3Like, direction: THREE.Vector3Like): void {
    this.origin.set(origin.x, origin.y, origin.z);
    this.direction.set(direction.x, direction.y, direction.z);
    if (this.direction.lengthSq() < Number.EPSILON) this.direction.copy(FALLBACK_FORWARD);
    else this.direction.normalize();
    this.revision += 1;
  }

  copyFrom(other: AuthoritativeAimState): void {
    this.origin.copy(other.origin);
    this.direction.copy(other.direction);
    this.revision = other.revision;
  }
}
