import type { BallisticEnvironment } from "../combat/BallisticEnvironment";
import type { ShotResult } from "../combat/ShotResult";
import type { ShotTraceMode } from "../combat/ShotTrace";
import type { PlayerStance } from "../core/PlayerMotor";
import type { WeaponSnapshot } from "../weapons/WeaponSystem";

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
}

export interface BallisticEnvironmentTelemetry {
  readonly gravityMetresPerSecondSquared: number;
  readonly windXMetresPerSecond: number;
  readonly windZMetresPerSecond: number;
}

export interface CombatSnapshot {
  readonly weapon: WeaponSnapshot | null;
  readonly range: CombatRangeSample | null;
  readonly lastShot: ShotTelemetry | null;
  readonly recentShots: readonly ShotTelemetry[];
  readonly aimResolution: AimResolutionSample | null;
  readonly ballistics: BallisticEnvironmentTelemetry | null;
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
    const lastShot: ShotTelemetry = {
      sequence: result.shot.sequence,
      sourceId: result.shot.sourceId,
      mode: result.trace.mode,
      hit: result.hit !== null,
      kind: result.hit?.kind ?? null,
      targetId: report?.targetId ?? null,
      objectName: impact?.objectName || null,
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
    };
    this.replace({
      ...this.snapshot,
      lastShot,
      recentShots: [lastShot, ...this.snapshot.recentShots].slice(0, 5),
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
