import type { HitscanResult } from "../combat/HitscanResolver";
import type { WeaponSnapshot } from "../weapons/WeaponSystem";

export type CombatRangeKind = "terrain" | "target" | "world";

export interface CombatRangeSample {
  readonly metres: number;
  readonly kind: CombatRangeKind;
}

export interface ShotTelemetry {
  readonly sequence: number;
  readonly hit: boolean;
  readonly kind: CombatRangeKind | null;
  readonly damage: number;
  readonly destroyed: boolean;
  readonly metres: number | null;
}

export interface CombatSnapshot {
  readonly weapon: WeaponSnapshot | null;
  readonly range: CombatRangeSample | null;
  readonly lastShot: ShotTelemetry | null;
  readonly dryFireSequence: number;
}

type Listener = () => void;

const EMPTY: CombatSnapshot = {
  weapon: null,
  range: null,
  lastShot: null,
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
    this.replace({
      ...this.snapshot,
      lastShot: {
        sequence: result.shot.sequence,
        hit: result.hit !== null,
        kind: result.hit?.kind ?? null,
        damage: result.damageApplied,
        destroyed: result.destroyed,
        metres: result.hit?.distance ?? null,
      },
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
