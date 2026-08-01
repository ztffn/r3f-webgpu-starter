import type * as THREE from "three/webgpu";

/** Damageable-target truth emitted after damage has been applied. */
export interface TargetHitReport {
  readonly targetId: string;
  readonly objectName: string;
  readonly sourceId: string;
  readonly shotSequence: number;
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3 | null;
  readonly rangeMetres: number;
  readonly damageApplied: number;
  readonly healthBefore: number;
  readonly healthAfter: number;
  readonly destroyed: boolean;
}
