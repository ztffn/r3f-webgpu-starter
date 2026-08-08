import type { AmmunitionDefinition } from "../../combat/AmmunitionDefinition.ts";
import type {
  FireMode,
  WeaponCommand,
  WeaponDefinition,
} from "../../combat/WeaponDefinition.ts";
import {
  calculateDispersionConeRadians,
  DEFAULT_WEAPON_HANDLING_CONTEXT,
  DEFAULT_WEAPON_HANDLING_MODIFIERS,
  finiteNonNegative,
  type WeaponHandlingContext,
  type WeaponHandlingModifiers,
} from "./WeaponHandling.ts";

export type WeaponPhase = "ready" | "cooldown" | "reloading" | "empty";

export interface WeaponSnapshot {
  readonly weaponId: string;
  readonly displayName: string;
  readonly magazine: number;
  readonly magazineSize: number;
  readonly reserve: number;
  readonly phase: WeaponPhase;
  readonly fireMode: FireMode;
  readonly cooldownRemainingSeconds: number;
  readonly reloadRemainingSeconds: number;
  readonly reloadProgress: number;
  readonly adsWanted: boolean;
  readonly adsProgress: number;
  readonly triggerHeld: boolean;
  readonly automaticArmed: boolean;
  readonly dryFireEmittedForPress: boolean;
  readonly burstRoundsRemaining: number;
  readonly shotSequence: number;
  readonly instanceSeed: number;
  readonly recoilPitchRadians: number;
  readonly recoilYawRadians: number;
  readonly bloomRadians: number;
  readonly dispersionConeRadians: number;
  readonly swayFactor: number;
}

interface WeaponEventBase {
  readonly weaponId: string;
}

export type WeaponEvent =
  | (WeaponEventBase & {
      readonly type: "shot";
      readonly sequence: number;
      /**
       * Seconds elapsed inside the `update(dt)` call that accepted this round.
       * Commands accepted between updates report `0`, so a frame host can place
       * every accepted round on one simulation timeline.
       */
      readonly acceptedAtOffsetSeconds: number;
      readonly damage: number;
      readonly range: number;
      readonly maxFlightSeconds: number;
      readonly ammunition: AmmunitionDefinition;
      readonly recoilOffsetPitchRadians: number;
      readonly recoilOffsetYawRadians: number;
      readonly dispersionPitchRadians: number;
      readonly dispersionYawRadians: number;
      readonly dispersionConeRadians: number;
      readonly recoilImpulsePitchRadians: number;
      readonly recoilImpulseYawRadians: number;
    })
  | (WeaponEventBase & { readonly type: "dry-fire" })
  | (WeaponEventBase & { readonly type: "reload-started" })
  | (WeaponEventBase & { readonly type: "reload-completed" })
  | (WeaponEventBase & { readonly type: "ads-changed"; readonly wanted: boolean })
  | (WeaponEventBase & { readonly type: "fire-mode-changed"; readonly fireMode: FireMode });

/** Longest simulation time one `update()` call may consume. */
export const WEAPON_UPDATE_MAX_SECONDS = 0.1;

const DT_MAX = WEAPON_UPDATE_MAX_SECONDS;
const TIME_EPSILON = 1e-9;
const UINT32_RANGE = 0x1_0000_0000;
const TWO_PI = Math.PI * 2;

function hashString32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Stable per-instance seed for one weapon in one shooter's loadout. Two copies
 * of the same definition must not share a recoil and dispersion pattern, and
 * replaying the same shooter seed must reproduce it exactly.
 */
export function deriveWeaponInstanceSeed(
  shooterSeed: number,
  slotId: string,
  weaponId: string
): number {
  // Integer, because the value is reduced to 32 bits below: `1`, `1.5`, and
  // `4294967297` would otherwise all produce byte-identical loadouts.
  if (!Number.isInteger(shooterSeed) || Math.abs(shooterSeed) > 0xffff_ffff) {
    throw new Error(`Shooter seed must be a 32-bit integer, received ${shooterSeed}`);
  }
  const slotHash = hashString32(`${slotId}:${weaponId}`);
  return mix32(slotHash ^ Math.imul(shooterSeed >>> 0, 0x9e3779b1));
}

function assertFinitePositive(value: number, label: string, weaponId: string): void {
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new Error(`Weapon ${weaponId} needs a finite positive ${label}`);
  }
}

function assertFiniteNonNegative(value: number, label: string, weaponId: string): void {
  if (!Number.isFinite(value) || !(value >= 0)) {
    throw new Error(`Weapon ${weaponId} needs a finite non-negative ${label}`);
  }
}

function assertPositiveInteger(value: number, label: string, weaponId: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Weapon ${weaponId} needs a positive whole ${label}`);
  }
}

function assertNonNegativeInteger(value: number, label: string, weaponId: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Weapon ${weaponId} needs a non-negative whole ${label}`);
  }
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/** Mutable, render-agnostic runtime for one weapon instance. */
export class WeaponSystem {
  readonly definition: WeaponDefinition;
  magazine: number;
  reserve: number;
  adsProgress = 0;

  private cooldownRemaining = 0;
  private reloadRemaining = 0;
  private adsWanted = false;
  private triggerHeld = false;
  private automaticArmed = false;
  private dryFireEmittedForPress = false;
  private burstRoundsRemaining = 0;
  private shotSequence = 0;
  private activeFireMode: FireMode;
  private recoilPitchRadians = 0;
  private recoilYawRadians = 0;
  private bloomRadians = 0;
  private updateCursorSeconds = 0;
  private handlingStance = DEFAULT_WEAPON_HANDLING_CONTEXT.stance;
  private handlingGrounded = DEFAULT_WEAPON_HANDLING_CONTEXT.grounded;
  private handlingPlanarSpeed = DEFAULT_WEAPON_HANDLING_CONTEXT.planarSpeedMetresPerSecond;
  private handlingSprinting = DEFAULT_WEAPON_HANDLING_CONTEXT.sprinting;
  private handlingBreath = DEFAULT_WEAPON_HANDLING_CONTEXT.breathStabilization;
  private dispersionFactor = DEFAULT_WEAPON_HANDLING_MODIFIERS.dispersionFactor;
  private recoilPitchFactor = DEFAULT_WEAPON_HANDLING_MODIFIERS.recoilPitchFactor;
  private recoilYawFactor = DEFAULT_WEAPON_HANDLING_MODIFIERS.recoilYawFactor;
  private recoilRecoveryFactor = DEFAULT_WEAPON_HANDLING_MODIFIERS.recoilRecoveryFactor;
  private bloomPerShotFactor = DEFAULT_WEAPON_HANDLING_MODIFIERS.bloomPerShotFactor;
  private bloomRecoveryFactor = DEFAULT_WEAPON_HANDLING_MODIFIERS.bloomRecoveryFactor;
  private swayFactor = DEFAULT_WEAPON_HANDLING_MODIFIERS.swayFactor;
  /**
   * Dev-console override of the authored ADS durations, or null for the definition's own.
   *
   * Deliberately absolute seconds rather than a factor on the handling-modifier path:
   * modifiers model attachments and perks, which SCALE an authored value, while this
   * replaces it so a tuning session reads and writes the same numbers that live in
   * `weaponDefinitions.ts` and can be pasted straight back there. Offline tuning only —
   * the server scores with the canonical definitions and never sees this.
   */
  private adsOverrideSeconds: { enterSeconds: number; exitSeconds: number } | null = null;
  private readonly instanceSeed: number;
  private readonly events: WeaponEvent[] = [];

  /**
   * `instanceSeed` is required on purpose. Defaulting it to the definition id
   * silently gave every copy of a weapon one shared recoil and dispersion
   * pattern; use `deriveWeaponInstanceSeed` for a stable per-shooter value.
   */
  constructor(definition: WeaponDefinition, instanceSeed: number) {
    this.validateDefinition(definition);
    if (!Number.isInteger(instanceSeed)) {
      throw new Error(`Weapon ${definition.id} needs an integer instance seed`);
    }
    this.definition = definition;
    this.magazine = definition.ammo.magazineSize;
    this.reserve = definition.ammo.initialReserve;
    this.activeFireMode = definition.fireModes.default;
    this.instanceSeed = instanceSeed >>> 0;
  }

  handleCommand(command: Exclude<WeaponCommand, { type: "equipSlot" }>): void {
    if (command.type === "triggerDown") this.triggerDown();
    else if (command.type === "triggerUp") this.triggerUp();
    else if (command.type === "selectFireMode") this.selectFireMode();
    else this.requestReload();
  }

  setAdsWanted(wanted: boolean): void {
    if (this.adsWanted === wanted) return;
    this.adsWanted = wanted;
    this.events.push({ type: "ads-changed", weaponId: this.definition.id, wanted });
  }

  setHandlingContext(context: WeaponHandlingContext): void {
    this.handlingSprinting = context.sprinting;
    this.handlingStance = context.stance;
    this.handlingGrounded = context.grounded;
    this.handlingPlanarSpeed = finiteNonNegative(context.planarSpeedMetresPerSecond);
    this.handlingBreath = Math.min(1, finiteNonNegative(context.breathStabilization));
  }

  setAdsOverrideSeconds(override: { enterSeconds: number; exitSeconds: number } | null): void {
    this.adsOverrideSeconds = override;
  }

  setHandlingModifiers(modifiers: WeaponHandlingModifiers): void {
    this.dispersionFactor = finiteNonNegative(modifiers.dispersionFactor);
    this.recoilPitchFactor = finiteNonNegative(modifiers.recoilPitchFactor);
    this.recoilYawFactor = finiteNonNegative(modifiers.recoilYawFactor);
    this.recoilRecoveryFactor = finiteNonNegative(modifiers.recoilRecoveryFactor);
    this.bloomPerShotFactor = finiteNonNegative(modifiers.bloomPerShotFactor);
    this.bloomRecoveryFactor = finiteNonNegative(modifiers.bloomRecoveryFactor);
    this.swayFactor = finiteNonNegative(modifiers.swayFactor);
  }

  update(dtSeconds: number): void {
    // The cursor makes every event emitted inside this call carry its exact
    // acceptance offset. Rounds accepted by a command between updates keep
    // offset zero, which is the start of the next simulation step.
    this.updateCursorSeconds = 0;
    this.advanceUpdate(dtSeconds);
    this.updateCursorSeconds = 0;
  }

  private advanceUpdate(dtSeconds: number): void {
    let dt = Number.isFinite(dtSeconds) ? Math.min(Math.max(dtSeconds, 0), DT_MAX) : 0;

    if (this.reloadRemaining > 0) {
      const reloadElapsed = Math.min(dt, this.reloadRemaining);
      this.advanceContinuousState(reloadElapsed);
      this.updateCursorSeconds += reloadElapsed;
      this.reloadRemaining -= reloadElapsed;
      dt -= reloadElapsed;
      if (this.reloadRemaining <= TIME_EPSILON) {
        this.reloadRemaining = 0;
        this.completeReload();
      }
      if (dt <= TIME_EPSILON) {
        if (this.reloadRemaining === 0) this.advanceFiring(0);
        return;
      }
    }

    this.advanceFiring(dt);
  }

  drainEvents(visitor: (event: WeaponEvent) => void): void {
    for (const event of this.events) visitor(event);
    this.events.length = 0;
  }

  /** Clears inputs and cancellable actions when this weapon leaves the active slot. */
  deactivate(): void {
    this.triggerHeld = false;
    this.automaticArmed = false;
    this.dryFireEmittedForPress = false;
    this.burstRoundsRemaining = 0;
    this.reloadRemaining = 0;
    this.adsWanted = false;
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
      fireMode: this.activeFireMode,
      cooldownRemainingSeconds: this.cooldownRemaining,
      reloadRemainingSeconds: this.reloadRemaining,
      reloadProgress:
        this.reloadRemaining > 0
          ? 1 - this.reloadRemaining / this.definition.reload.durationSeconds
          : 0,
      adsWanted: this.adsWanted,
      adsProgress: this.adsProgress,
      triggerHeld: this.triggerHeld,
      automaticArmed: this.automaticArmed,
      dryFireEmittedForPress: this.dryFireEmittedForPress,
      burstRoundsRemaining: this.burstRoundsRemaining,
      shotSequence: this.shotSequence,
      instanceSeed: this.instanceSeed,
      recoilPitchRadians: this.recoilPitchRadians,
      recoilYawRadians: this.recoilYawRadians,
      bloomRadians: this.bloomRadians,
      dispersionConeRadians: this.calculateDispersionCone(),
      swayFactor: this.swayFactor,
    };
  }

  get phase(): WeaponPhase {
    if (this.reloadRemaining > 0) return "reloading";
    if (this.magazine === 0) return "empty";
    if (this.cooldownRemaining > TIME_EPSILON) return "cooldown";
    return "ready";
  }

  private triggerDown(): void {
    if (this.triggerHeld) return;
    this.triggerHeld = true;
    this.dryFireEmittedForPress = false;

    if (this.activeFireMode === "semi") {
      this.tryFireOnce();
      return;
    }
    if (this.activeFireMode === "burst") {
      this.tryStartBurst();
      return;
    }
    this.automaticArmed = true;
    this.tryFireOnce();
  }

  private triggerUp(): void {
    this.triggerHeld = false;
    this.automaticArmed = false;
  }

  private selectFireMode(): void {
    this.burstRoundsRemaining = 0;
    this.automaticArmed = false;
    const supported = this.definition.fireModes.supported;
    const nextIndex = (supported.indexOf(this.activeFireMode) + 1) % supported.length;
    const nextMode = supported[nextIndex];
    if (nextMode === this.activeFireMode) return;
    this.activeFireMode = nextMode;
    this.events.push({
      type: "fire-mode-changed",
      weaponId: this.definition.id,
      fireMode: this.activeFireMode,
    });
  }

  private requestReload(): void {
    this.burstRoundsRemaining = 0;
    if (
      this.reloadRemaining > 0 ||
      this.magazine >= this.definition.ammo.magazineSize ||
      this.reserve <= 0
    ) {
      return;
    }
    this.reloadRemaining = this.definition.reload.durationSeconds;
    this.events.push({ type: "reload-started", weaponId: this.definition.id });
  }

  private tryStartBurst(): void {
    if (
      this.burstRoundsRemaining > 0 ||
      this.reloadRemaining > 0 ||
      this.cooldownRemaining > TIME_EPSILON
    ) {
      return;
    }
    this.burstRoundsRemaining = this.definition.fireModes.burstSize ?? 3;
    if (this.tryFireOnce()) this.burstRoundsRemaining -= 1;
    else this.burstRoundsRemaining = 0;
  }

  private advanceFiring(dtSeconds: number): void {
    let remaining = dtSeconds;
    // Every exit runs this. A path that returned without spending `remaining`
    // used to freeze ADS progress, recoil recovery, and bloom recovery for as
    // long as the trigger stayed down on an empty automatic weapon, and left
    // the cursor short of the time the update was given.
    const consumeRemainder = () => {
      this.advanceContinuousState(remaining);
      this.updateCursorSeconds += remaining;
      remaining = 0;
    };

    while (true) {
      if (this.cooldownRemaining > remaining + TIME_EPSILON) return consumeRemainder();
      const toBoundary = this.cooldownRemaining;
      this.advanceContinuousState(toBoundary);
      this.updateCursorSeconds += toBoundary;
      remaining = Math.max(0, remaining - toBoundary);

      if (this.burstRoundsRemaining > 0) {
        if (!this.tryFireOnce()) {
          this.burstRoundsRemaining = 0;
          return consumeRemainder();
        }
        this.burstRoundsRemaining -= 1;
      } else if (this.activeFireMode === "auto" && this.triggerHeld && this.automaticArmed) {
        if (!this.tryFireOnce()) return consumeRemainder();
      } else {
        return consumeRemainder();
      }

      if (remaining <= TIME_EPSILON) return;
    }
  }

  private advanceContinuousState(dtSeconds: number): void {
    if (dtSeconds <= 0) return;
    this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dtSeconds);
    const ads = this.adsOverrideSeconds ?? this.definition.ads;
    const adsDuration = this.adsWanted ? ads.enterSeconds : ads.exitSeconds;
    const adsDirection = this.adsWanted ? 1 : -1;
    const adsStep = adsDuration <= 0 ? 1 : dtSeconds / adsDuration;
    this.adsProgress = Math.min(1, Math.max(0, this.adsProgress + adsDirection * adsStep));

    const recoilRecovery =
      this.definition.recoil.recoveryPerSecond * this.recoilRecoveryFactor;
    const recoilDecay = Math.exp(-recoilRecovery * dtSeconds);
    this.recoilPitchRadians *= recoilDecay;
    this.recoilYawRadians *= recoilDecay;
    const bloomRecovery =
      this.definition.accuracy.bloomRecoveryPerSecond * this.bloomRecoveryFactor;
    this.bloomRadians *= Math.exp(-bloomRecovery * dtSeconds);
  }

  private tryFireOnce(): boolean {
    if (this.reloadRemaining > 0 || this.cooldownRemaining > TIME_EPSILON) return false;
    // Refused before the magazine is touched, so sprinting never consumes a
    // round, never starts a cooldown, and never reports a dry fire.
    if (this.handlingSprinting) return false;
    if (this.magazine <= 0) {
      if (!this.dryFireEmittedForPress) {
        this.dryFireEmittedForPress = true;
        this.events.push({ type: "dry-fire", weaponId: this.definition.id });
      }
      return false;
    }

    this.magazine -= 1;
    this.shotSequence += 1;
    this.cooldownRemaining = 60 / this.definition.shot.roundsPerMinute;
    const dispersionConeRadians = this.calculateDispersionCone();
    const shotHash = mix32(this.instanceSeed ^ Math.imul(this.shotSequence, 0x9e3779b1));
    const radiusSample = mix32(shotHash ^ 0xa511e9b3) / UINT32_RANGE;
    const angleSample = mix32(shotHash ^ 0x63d83595) / UINT32_RANGE;
    const radius = Math.sqrt(radiusSample) * dispersionConeRadians;
    const angle = angleSample * TWO_PI;
    const dispersionPitchRadians = Math.sin(angle) * radius;
    const dispersionYawRadians = Math.cos(angle) * radius;
    const yawSign = (mix32(shotHash ^ 0xc2b2ae35) & 1) === 0 ? -1 : 1;
    const recoilImpulsePitchRadians =
      this.definition.recoil.pitchRadians * this.recoilPitchFactor;
    const recoilImpulseYawRadians =
      this.definition.recoil.yawRadians * this.recoilYawFactor * yawSign;
    this.events.push({
      type: "shot",
      weaponId: this.definition.id,
      sequence: this.shotSequence,
      acceptedAtOffsetSeconds: this.updateCursorSeconds,
      damage: this.definition.shot.damage,
      range: this.definition.shot.range,
      maxFlightSeconds: this.definition.shot.maxFlightSeconds,
      ammunition: this.definition.shot.ammunition,
      recoilOffsetPitchRadians: this.recoilPitchRadians,
      recoilOffsetYawRadians: this.recoilYawRadians,
      dispersionPitchRadians,
      dispersionYawRadians,
      dispersionConeRadians,
      recoilImpulsePitchRadians,
      recoilImpulseYawRadians,
    });
    this.recoilPitchRadians = Math.min(
      this.definition.recoil.maxPitchRadians * this.recoilPitchFactor,
      this.recoilPitchRadians + recoilImpulsePitchRadians
    );
    const maxYaw = this.definition.recoil.maxYawRadians * this.recoilYawFactor;
    this.recoilYawRadians = Math.min(
      maxYaw,
      Math.max(-maxYaw, this.recoilYawRadians + recoilImpulseYawRadians)
    );
    this.bloomRadians = Math.min(
      this.definition.accuracy.maxBloomRadians,
      this.bloomRadians +
        this.definition.accuracy.bloomPerShotRadians * this.bloomPerShotFactor
    );
    return true;
  }

  private calculateDispersionCone(): number {
    return calculateDispersionConeRadians(
      this.definition.accuracy,
      this.adsProgress,
      this.bloomRadians,
      this.handlingStance,
      this.handlingGrounded,
      this.handlingPlanarSpeed,
      this.handlingBreath,
      this.dispersionFactor
    );
  }

  private completeReload(): void {
    const needed = this.definition.ammo.magazineSize - this.magazine;
    const transferred = Math.min(needed, this.reserve);
    this.magazine += transferred;
    this.reserve -= transferred;
    this.events.push({ type: "reload-completed", weaponId: this.definition.id });
  }

  private validateDefinition(definition: WeaponDefinition): void {
    const supported = definition.fireModes.supported;
    if (supported.length === 0 || !supported.includes(definition.fireModes.default)) {
      throw new Error(`Weapon ${definition.id} must support its default fire mode`);
    }
    if (new Set(supported).size !== supported.length) {
      throw new Error(`Weapon ${definition.id} has duplicate fire modes`);
    }
    if (
      supported.includes("burst") &&
      (!Number.isInteger(definition.fireModes.burstSize ?? 0) ||
        (definition.fireModes.burstSize ?? 0) < 2)
    ) {
      throw new Error(`Weapon ${definition.id} needs a burst size of at least two`);
    }
    // Every authored runtime number is checked before any state is built.
    // An infinite cadence empties a magazine inside one millisecond update, a
    // zero-duration reload starts and never completes, and an invalid range or
    // lifetime consumes a cartridge that projectile spawn then rejects.
    const id = definition.id;
    assertFinitePositive(definition.shot.roundsPerMinute, "firing cadence", id);
    assertFinitePositive(definition.shot.range, "shot range", id);
    assertFinitePositive(definition.shot.maxFlightSeconds, "shot lifetime", id);
    assertFiniteNonNegative(definition.shot.damage, "shot damage", id);
    assertPositiveInteger(definition.ammo.magazineSize, "magazine size", id);
    assertNonNegativeInteger(definition.ammo.initialReserve, "initial reserve", id);
    assertFinitePositive(definition.reload.durationSeconds, "reload duration", id);
    assertFiniteNonNegative(definition.ads.enterSeconds, "ADS enter duration", id);
    assertFiniteNonNegative(definition.ads.exitSeconds, "ADS exit duration", id);

    const ammunition = definition.shot.ammunition;
    assertFinitePositive(ammunition.projectileMassKilograms, "projectile mass", id);
    assertFinitePositive(ammunition.muzzleVelocityMetresPerSecond, "muzzle velocity", id);
    assertFinitePositive(ammunition.ballisticCoefficientG1, "ballistic coefficient", id);
    assertFinitePositive(ammunition.penetrationMultiplier, "penetration multiplier", id);
    assertFiniteNonNegative(ammunition.baseDamage, "ammunition base damage", id);

    const accuracyValues = Object.values(definition.accuracy);
    if (accuracyValues.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error(`Weapon ${definition.id} needs finite non-negative accuracy values`);
    }
    if (
      definition.accuracy.bloomRecoveryPerSecond <= 0 ||
      definition.accuracy.maxBloomRadians < definition.accuracy.bloomPerShotRadians
    ) {
      throw new Error(`Weapon ${definition.id} has invalid bloom recovery or capacity`);
    }
    const recoilValues = Object.values(definition.recoil);
    if (recoilValues.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error(`Weapon ${definition.id} needs finite non-negative recoil values`);
    }
    if (
      definition.recoil.recoveryPerSecond <= 0 ||
      definition.recoil.maxPitchRadians < definition.recoil.pitchRadians ||
      definition.recoil.maxYawRadians < definition.recoil.yawRadians
    ) {
      throw new Error(`Weapon ${definition.id} has invalid recoil recovery or capacity`);
    }
  }
}
