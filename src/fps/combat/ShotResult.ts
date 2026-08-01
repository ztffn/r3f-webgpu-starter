import type { WorldHit } from "../core/WorldQuery";
import type { ShotTrace } from "./ShotTrace";
import type { TargetHitReport } from "./TargetHitReport";

export interface ResolvedShotIdentity {
  readonly sourceId: string;
  readonly sequence: number;
}

/** Common completed-shot contract consumed by HUD/debug presentation. */
export interface ShotResult<TShot extends ResolvedShotIdentity = ResolvedShotIdentity> {
  readonly shot: TShot;
  readonly hit: WorldHit | null;
  readonly damageApplied: number;
  readonly destroyed: boolean;
  readonly report: TargetHitReport | null;
  readonly reports: readonly TargetHitReport[];
  readonly trace: ShotTrace;
}
