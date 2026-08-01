import type { BallisticEnvironment } from "../combat/BallisticEnvironment";
import type { ShotResult } from "../combat/ShotResult";
import type { ShotTraceMode } from "../combat/ShotTrace";
import type { PlayerStance } from "../core/PlayerMotor";
import type { ScopeAdjustmentSnapshot } from "../core/ScopeAdjustmentController";
import type { WeaponSnapshot } from "../weapons/WeaponSystem";
import type { AmmunitionId } from "../weapons/AmmunitionDefinition";
import type { PenetrationOutcome } from "../combat/PenetrationResolver";
import type { SurfaceId } from "../combat/SurfaceProfile";
import type { ImpactEvent } from "../combat/ImpactEvent";

export type CombatRangeKind = "terrain" | "target" | "world";

export interface CombatRangeSample {
  readonly metres: number;
  readonly kind: CombatRangeKind;
}

export interface AimResolutionSample {
  readonly centimetresPerCount: number;
  readonly rangeMetres: number;
  readonly swayMetresAtRange: number;
  readonly breathStabilization: number;
  readonly stance: PlayerStance;
}

export interface ShotTelemetry {
  readonly sequence: number;
  readonly sourceId: string;
  readonly mode: ShotTraceMode;
  readonly hit: boolean;
  readonly kind: CombatRangeKind | null;
  readonly targetId: string | null;
  readonly objectName: string | null;
  readonly damage: number;
  readonly healthBefore: number | null;
  readonly healthAfter: number | null;
  readonly destroyed: boolean;
  readonly metres: number | null;
  readonly point: readonly [number, number, number] | null;
  readonly flightTimeSeconds: number;
  readonly verticalDropMetres: number;
  readonly lateralDriftMetres: number;
  readonly impactSpeedMetresPerSecond: number | null;
  readonly ammunitionId: AmmunitionId | null;
  readonly surfaceId: SurfaceId | null;
  readonly penetrationOutcome: PenetrationOutcome | null;
  readonly interactionCount: number;
  readonly effectiveThicknessMetres: number | null;
  readonly retainedSpeedMetresPerSecond: number | null;
}

export interface BallisticEnvironmentTelemetry {
  readonly gravityMetresPerSecondSquared: number;
  readonly windXMetresPerSecond: number;
  readonly windZMetresPerSecond: number;
}

export interface ImpactTelemetry {
  readonly shotSequence: number;
  readonly interactionIndex: number;
  readonly ammunitionId: AmmunitionId;
  readonly surfaceId: SurfaceId;
  readonly outcome: PenetrationOutcome;
  readonly targetId: string | null;
  readonly damageApplied: number;
  readonly healthAfter: number | null;
  readonly destroyed: boolean;
  readonly effectiveThicknessMetres: number;
  readonly speedBeforeMetresPerSecond: number;
  readonly speedAfterMetresPerSecond: number;
}

export interface CombatSnapshot {
  readonly weapon: WeaponSnapshot | null;
  readonly range: CombatRangeSample | null;
  readonly lastShot: ShotTelemetry | null;
  readonly recentShots: readonly ShotTelemetry[];
  readonly aimResolution: AimResolutionSample | null;
  readonly ballistics: BallisticEnvironmentTelemetry | null;
  readonly scopeAdjustment: ScopeAdjustmentSnapshot | null;
  readonly lastImpact: ImpactTelemetry | null;
  readonly dryFireSequence: number;
  readonly projectileRejectSequence: number;
}

type Listener = () => void;

const EMPTY: CombatSnapshot = {
  weapon: null,
  range: null,
  lastShot: null,
  recentShots: [],
  aimResolution: null,
  ballistics: null,
  scopeAdjustment: null,
  lastImpact: null,
  dryFireSequence: 0,
  projectileRejectSequence: 0,
};

export class CombatTelemetry {
  private snapshot: CombatSnapshot = EMPTY;
  private readonly listeners = new Set<Listener>();

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): CombatSnapshot => this.snapshot;

  publishWeapon(weapon: WeaponSnapshot): void {
    const previous = this.snapshot.weapon;
    if (
      previous &&
      previous.weaponId === weapon.weaponId &&
      previous.magazine === weapon.magazine &&
      previous.reserve === weapon.reserve &&
      previous.phase === weapon.phase &&
      Math.abs(previous.reloadProgress - weapon.reloadProgress) < 0.02 &&
      Math.abs(previous.adsProgress - weapon.adsProgress) < 0.02
    ) {
      return;
    }
    this.replace({ ...this.snapshot, weapon });
  }

  publishRange(range: CombatRangeSample | null): void {
    const previous = this.snapshot.range;
    if (
      previous === range ||
      (previous && range && previous.kind === range.kind && Math.abs(previous.metres - range.metres) < 0.05)
    ) {
      return;
    }
    this.replace({ ...this.snapshot, range });
  }

  publishShot(result: ShotResult): void {
    const report = result.report;
    const impact = result.trace.impact;
    const interactions = result.trace.interactions;
    const lastInteraction = interactions.at(-1) ?? null;
    const lastShot: ShotTelemetry = {
      sequence: result.shot.sequence,
      sourceId: result.shot.sourceId,
      mode: result.trace.mode,
      hit: result.hit !== null || interactions.length > 0,
      kind: result.hit?.kind ?? lastInteraction?.kind ?? null,
      targetId: report?.targetId ?? null,
      objectName: impact?.objectName || lastInteraction?.objectName || null,
      damage: result.damageApplied,
      healthBefore: report?.healthBefore ?? null,
      healthAfter: report?.healthAfter ?? null,
      destroyed: result.destroyed,
      metres: result.hit?.distance ?? null,
      point: impact ? [impact.point.x, impact.point.y, impact.point.z] : null,
      flightTimeSeconds: result.trace.flightTimeSeconds,
      verticalDropMetres: result.trace.verticalDropMetres,
      lateralDriftMetres: result.trace.lateralDriftMetres,
      impactSpeedMetresPerSecond: result.trace.impactSpeedMetresPerSecond,
      ammunitionId: lastInteraction?.ammunitionId ?? null,
      surfaceId: lastInteraction?.surfaceId ?? null,
      penetrationOutcome: lastInteraction?.outcome ?? null,
      interactionCount: interactions.length,
      effectiveThicknessMetres: lastInteraction?.effectiveThicknessMetres ?? null,
      retainedSpeedMetresPerSecond: lastInteraction?.speedAfterMetresPerSecond ?? null,
    };
    this.replace({
      ...this.snapshot,
      lastShot,
      recentShots: [lastShot, ...this.snapshot.recentShots].slice(0, 5),
    });
  }

  publishImpact(event: ImpactEvent): void {
    this.replace({
      ...this.snapshot,
      lastImpact: {
        shotSequence: event.shotSequence,
        interactionIndex: event.interactionIndex,
        ammunitionId: event.ammunitionId,
        surfaceId: event.surfaceId,
        outcome: event.outcome,
        targetId: event.targetId,
        damageApplied: event.damageApplied,
        healthAfter: event.healthAfter,
        destroyed: event.destroyed,
        effectiveThicknessMetres: event.effectiveThicknessMetres,
        speedBeforeMetresPerSecond: event.speedBeforeMetresPerSecond,
        speedAfterMetresPerSecond: event.speedAfterMetresPerSecond,
      },
    });
  }

  publishBallisticEnvironment(environment: BallisticEnvironment): void {
    const ballistics = {
      gravityMetresPerSecondSquared: Math.hypot(
        environment.gravity.x,
        environment.gravity.y,
        environment.gravity.z
      ),
      windXMetresPerSecond: environment.windVelocity.x,
      windZMetresPerSecond: environment.windVelocity.z,
    };
    const previous = this.snapshot.ballistics;
    if (
      previous &&
      previous.gravityMetresPerSecondSquared === ballistics.gravityMetresPerSecondSquared &&
      previous.windXMetresPerSecond === ballistics.windXMetresPerSecond &&
      previous.windZMetresPerSecond === ballistics.windZMetresPerSecond
    ) {
      return;
    }
    this.replace({ ...this.snapshot, ballistics });
  }

  publishScopeAdjustment(scopeAdjustment: ScopeAdjustmentSnapshot): void {
    if (this.snapshot.scopeAdjustment === scopeAdjustment) return;
    this.replace({ ...this.snapshot, scopeAdjustment });
  }

  publishAimDiagnostics(
    centimetresPerCount: number,
    rangeMetres: number,
    swayMetresAtRange: number,
    breathStabilization: number,
    stance: PlayerStance
  ): void {
    const previous = this.snapshot.aimResolution;
    if (
      previous &&
      previous.rangeMetres === rangeMetres &&
      previous.stance === stance &&
      Math.abs(previous.centimetresPerCount - centimetresPerCount) < 0.05 &&
      Math.abs(previous.swayMetresAtRange - swayMetresAtRange) < 0.01 &&
      Math.abs(previous.breathStabilization - breathStabilization) < 0.01
    ) {
      return;
    }
    this.replace({
      ...this.snapshot,
      aimResolution: {
        centimetresPerCount,
        rangeMetres,
        swayMetresAtRange,
        breathStabilization,
        stance,
      },
    });
  }

  publishDryFire(): void {
    this.replace({ ...this.snapshot, dryFireSequence: this.snapshot.dryFireSequence + 1 });
  }

  publishProjectileRejected(): void {
    this.replace({
      ...this.snapshot,
      projectileRejectSequence: this.snapshot.projectileRejectSequence + 1,
    });
  }

  clear(): void {
    this.replace(EMPTY);
  }

  private replace(next: CombatSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const combatTelemetry = new CombatTelemetry();
