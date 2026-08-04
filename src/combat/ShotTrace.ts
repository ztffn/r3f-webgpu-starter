import type { WorldHitKind } from "./WorldQuery.ts";
import type { ImpactEvent } from "./ImpactEvent.ts";
import type { Vec3Like } from "./math.ts";

export type ShotTraceMode = "hitscan" | "ballistic";

export interface ShotImpact {
  readonly point: Vec3Like;
  readonly normal: Vec3Like | null;
  readonly kind: WorldHitKind;
  readonly targetId: string | null;
  readonly objectName: string;
}

/** Resolved gameplay path. Presentation must draw this, never solve its own path. */
export interface ShotTrace {
  readonly shotSequence: number;
  readonly sourceId: string;
  readonly mode: ShotTraceMode;
  /** Optical aim after sway and pre-shot recoil, before the scope turret. */
  readonly sightDirection: Vec3Like;
  /** Mean bore: the sightline after elevation zero and windage, before spread. */
  readonly boreDirection: Vec3Like;
  /** Accepted projectile direction: the mean bore plus this shot's dispersion. */
  readonly initialDirection: Vec3Like;
  readonly points: readonly Vec3Like[];
  readonly interactions: readonly ImpactEvent[];
  readonly impact: ShotImpact | null;
  readonly flightTimeSeconds: number;
  readonly verticalDropMetres: number;
  readonly lateralDriftMetres: number;
  readonly pathLengthMetres: number;
  readonly impactSpeedMetresPerSecond: number | null;
}
