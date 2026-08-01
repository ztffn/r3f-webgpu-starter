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
}
