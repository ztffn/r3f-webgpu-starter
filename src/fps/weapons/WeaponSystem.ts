import type { WeaponDefinition } from "./WeaponDefinition";

export type WeaponPhase = "ready" | "cooldown" | "reloading" | "empty";

export interface WeaponSnapshot {
  readonly weaponId: string;
  readonly displayName: string;
  readonly magazine: number;
  readonly magazineSize: number;
  readonly reserve: number;
  readonly phase: WeaponPhase;
  readonly reloadProgress: number;
  readonly adsProgress: number;
}

export type WeaponEvent =
  | {
      readonly type: "shot";
      readonly sequence: number;
      readonly damage: number;
      readonly range: number;
      readonly muzzleVelocityMetresPerSecond: number;
      readonly ballisticCoefficientG1: number;
      readonly recoilPitch: number;
      readonly recoilYaw: number;
      readonly animationSegment?: number;
    }
  | { readonly type: "dry-fire"; readonly animationSegment?: number }
  | { readonly type: "reload-started"; readonly animationSegment?: number }
  | { readonly type: "reload-completed" }
  | { readonly type: "ads-changed"; readonly wanted: boolean };

const DT_MAX = 0.1;

/** Mutable, render-agnostic runtime for one weapon instance. */
export class WeaponSystem {
  readonly definition: WeaponDefinition;
  magazine: number;
  reserve: number;
  adsProgress = 0;

  private cooldownRemaining = 0;
  private reloadRemaining = 0;
  private adsWanted = false;
  private triggerPresses = 0;
  private reloadRequested = false;
  private shotSequence = 0;
  private readonly events: WeaponEvent[] = [];

  constructor(definition: WeaponDefinition) {
    this.definition = definition;
    this.magazine = definition.ammo.magazineSize;
    this.reserve = definition.ammo.initialReserve;
  }

  pressTrigger(): void {
    this.triggerPresses += 1;
  }

  requestReload(): void {
    this.reloadRequested = true;
  }

  setAdsWanted(wanted: boolean): void {
    if (this.adsWanted === wanted) return;
    this.adsWanted = wanted;
    this.events.push({ type: "ads-changed", wanted });
  }

  update(dtSeconds: number): void {
    const dt = Math.min(Math.max(dtSeconds, 0), DT_MAX);
    this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);

    if (this.reloadRemaining > 0) {
      this.reloadRemaining = Math.max(0, this.reloadRemaining - dt);
      if (this.reloadRemaining === 0) this.completeReload();
    }

    const adsDuration = this.adsWanted
      ? this.definition.ads.enterSeconds
      : this.definition.ads.exitSeconds;
    const adsDirection = this.adsWanted ? 1 : -1;
    const adsStep = adsDuration <= 0 ? 1 : dt / adsDuration;
    this.adsProgress = Math.min(1, Math.max(0, this.adsProgress + adsDirection * adsStep));

    if (this.reloadRequested) this.tryStartReload();
    this.reloadRequested = false;

    const presses = this.triggerPresses;
    this.triggerPresses = 0;
    for (let i = 0; i < presses; i += 1) this.tryFire();
  }

  drainEvents(visitor: (event: WeaponEvent) => void): void {
    for (const event of this.events) visitor(event);
    this.events.length = 0;
  }

  getSnapshot(): WeaponSnapshot {
    return {
      weaponId: this.definition.id,
      displayName: this.definition.displayName,
      magazine: this.magazine,
      magazineSize: this.definition.ammo.magazineSize,
      reserve: this.reserve,
      phase: this.phase,
      reloadProgress:
        this.reloadRemaining > 0
          ? 1 - this.reloadRemaining / this.definition.reload.durationSeconds
          : 0,
      adsProgress: this.adsProgress,
    };
  }

  get phase(): WeaponPhase {
    if (this.reloadRemaining > 0) return "reloading";
    if (this.magazine === 0) return "empty";
    if (this.cooldownRemaining > 0) return "cooldown";
    return "ready";
  }

  private tryFire(): void {
    if (this.reloadRemaining > 0 || this.cooldownRemaining > 0) return;
    if (this.magazine <= 0) {
      this.events.push({
        type: "dry-fire",
        animationSegment: this.definition.animations.dryFireSegment,
      });
      return;
    }

    this.magazine -= 1;
    this.shotSequence += 1;
    this.cooldownRemaining = 60 / this.definition.shot.roundsPerMinute;
    this.events.push({
      type: "shot",
      sequence: this.shotSequence,
      damage: this.definition.shot.damage,
      range: this.definition.shot.range,
      muzzleVelocityMetresPerSecond: this.definition.shot.muzzleVelocityMetresPerSecond,
      ballisticCoefficientG1: this.definition.shot.ballisticCoefficientG1,
      recoilPitch: this.definition.recoil.pitchRadians,
      recoilYaw: this.definition.recoil.yawRadians,
      animationSegment: this.definition.animations.fireSegment,
    });
  }

  private tryStartReload(): void {
    if (
      this.reloadRemaining > 0 ||
      this.magazine >= this.definition.ammo.magazineSize ||
      this.reserve <= 0
    ) {
      return;
    }
    this.reloadRemaining = this.definition.reload.durationSeconds;
    this.events.push({
      type: "reload-started",
      animationSegment: this.definition.animations.reloadSegment,
    });
  }

  private completeReload(): void {
    const needed = this.definition.ammo.magazineSize - this.magazine;
    const transferred = Math.min(needed, this.reserve);
    this.magazine += transferred;
    this.reserve -= transferred;
    this.events.push({ type: "reload-completed" });
  }
}
