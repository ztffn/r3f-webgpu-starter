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

/**
 * Weapon state the MOTOR needs, published by whoever owns the weapon.
 *
 * Deliberately one boolean. `WeaponSystem` owns ADS — its progress, whether a
 * reload refuses it, all of it — and this is only the intent the motor turns
 * into a speed penalty. Reading the weapon's resolved ADS instead would put
 * gameplay state the server cannot replay into the movement path.
 */
export interface PlayerWeaponIntent {
  aiming: boolean;
}
