import type * as THREE from "three/webgpu";

export type PlayerStance = "stand" | "crouch" | "prone";

/**
 * Narrow seam for a future collision/physics motor. The current camera motor
 * writes these values into LocalPlayerController through syncPresentationPose.
 */
export interface PlayerMotorSnapshot {
  readonly position: THREE.Vector3Like;
  readonly stance: PlayerStance;
  readonly grounded: boolean;
  readonly planarSpeedMetresPerSecond: number;
}

/**
 * Writable view, published once per frame by whatever actually simulates the
 * player and read by the weapon host.
 *
 * This is the seam that lets weapon handling stop inferring the player's state
 * from the camera. Differentiating camera position gives a usable speed, but
 * `grounded` cannot be derived that way at all — without a real motor it is
 * whatever the app's fly/on-foot toggle says, which stays true through a jump,
 * so airborne dispersion never applies.
 */
export interface PlayerMotorSnapshotTarget {
  position: THREE.Vector3;
  stance: PlayerStance;
  grounded: boolean;
  planarSpeedMetresPerSecond: number;
}
