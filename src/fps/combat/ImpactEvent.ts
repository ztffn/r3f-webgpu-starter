import type * as THREE from "three/webgpu";
import type { WorldHitKind } from "../core/WorldQuery";
import type { AmmunitionId } from "../weapons/AmmunitionDefinition";
import type { PenetrationOutcome } from "./PenetrationResolver";
import type { SurfaceId } from "./SurfaceProfile";

export interface ImpactEvent {
  readonly sourceId: string;
  readonly shotSequence: number;
  readonly interactionIndex: number;
  readonly ammunitionId: AmmunitionId;
  readonly kind: WorldHitKind;
  readonly objectId: string;
  readonly objectName: string;
  readonly targetId: string | null;
  readonly damageApplied: number;
  readonly healthBefore: number | null;
  readonly healthAfter: number | null;
  readonly destroyed: boolean;
  readonly surfaceId: SurfaceId;
  readonly outcome: PenetrationOutcome;
  readonly point: THREE.Vector3;
  readonly exitPoint: THREE.Vector3 | null;
  readonly normal: THREE.Vector3 | null;
  readonly effectiveThicknessMetres: number;
  readonly speedBeforeMetresPerSecond: number;
  readonly speedAfterMetresPerSecond: number;
  readonly energyBeforeJoules: number;
  readonly energyAfterJoules: number;
}
