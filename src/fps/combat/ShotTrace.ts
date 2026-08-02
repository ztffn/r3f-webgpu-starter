import type * as THREE from "three/webgpu";
import type { WorldHitKind } from "../core/WorldQuery";
import type { ImpactEvent } from "./ImpactEvent";

export type ShotTraceMode = "hitscan" | "ballistic";

export interface ShotImpact {
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3 | null;
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
  readonly sightDirection: THREE.Vector3;
  /** Mean bore: the sightline after elevation zero and windage, before spread. */
  readonly boreDirection: THREE.Vector3;
  /** Accepted projectile direction: the mean bore plus this shot's dispersion. */
  readonly initialDirection: THREE.Vector3;
  readonly points: readonly THREE.Vector3[];
  readonly interactions: readonly ImpactEvent[];
  readonly impact: ShotImpact | null;
  readonly flightTimeSeconds: number;
  readonly verticalDropMetres: number;
  readonly lateralDriftMetres: number;
  readonly pathLengthMetres: number;
  readonly impactSpeedMetresPerSecond: number | null;
}
