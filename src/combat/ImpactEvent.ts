import type { WorldHitKind } from "./WorldQuery.ts";
import type { AmmunitionId } from "./AmmunitionDefinition.ts";
import type { PenetrationOutcome } from "./PenetrationResolver.ts";
import type { SurfaceId } from "./SurfaceProfile.ts";
import type { Vec3Like } from "./math.ts";

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
  readonly point: Vec3Like;
  readonly exitPoint: Vec3Like | null;
  readonly normal: Vec3Like | null;
  readonly effectiveThicknessMetres: number;
  readonly speedBeforeMetresPerSecond: number;
  readonly speedAfterMetresPerSecond: number;
  readonly energyBeforeJoules: number;
  readonly energyAfterJoules: number;
}
