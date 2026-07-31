import type * as THREE from "three/webgpu";
import type { WorldHitKind } from "../core/WorldQuery";

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
  readonly points: readonly THREE.Vector3[];
  readonly impact: ShotImpact | null;
  readonly flightTimeSeconds: number;
  readonly verticalDropMetres: number;
  readonly lateralDriftMetres: number;
}
