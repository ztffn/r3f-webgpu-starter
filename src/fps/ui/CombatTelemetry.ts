import type { HitscanResult } from "../combat/HitscanResolver";
import type { ShotTraceMode } from "../combat/ShotTrace";
import type { WeaponSnapshot } from "../weapons/WeaponSystem";

export type CombatRangeKind = "terrain" | "target" | "world";

export interface CombatRangeSample {
  readonly metres: number;
  readonly kind: CombatRangeKind;
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
}

export interface CombatSnapshot {
  readonly weapon: WeaponSnapshot | null;
  readonly range: CombatRangeSample | null;
  readonly lastShot: ShotTelemetry | null;
  readonly recentShots: readonly ShotTelemetry[];
  readonly dryFireSequence: number;
}

type Listener = () => void;

const EMPTY: CombatSnapshot = {
  weapon: null,
  range: null,
  lastShot: null,
  recentShots: [],
  dryFireSequence: 0,
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

  publishShot(result: HitscanResult): void {
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
    };
    this.replace({
      ...this.snapshot,
      lastShot,
      recentShots: [lastShot, ...this.snapshot.recentShots].slice(0, 5),
    });
  }

  publishDryFire(): void {
    this.replace({ ...this.snapshot, dryFireSequence: this.snapshot.dryFireSequence + 1 });
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
