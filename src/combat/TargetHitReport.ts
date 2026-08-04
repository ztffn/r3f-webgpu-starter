import type { Vec3Like } from "./math.ts";

/** Damageable-target truth emitted after damage has been applied. */
export interface TargetHitReport {
  readonly targetId: string;
  readonly objectName: string;
  readonly sourceId: string;
  readonly shotSequence: number;
  readonly point: Vec3Like;
  readonly normal: Vec3Like | null;
  readonly rangeMetres: number;
  readonly damageApplied: number;
  readonly healthBefore: number;
  readonly healthAfter: number;
  readonly destroyed: boolean;
}
