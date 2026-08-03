import type { PlayerStance } from "../core/PlayerMotor.ts";
import type { WeaponAccuracyDefinition } from "./WeaponDefinition.ts";

export interface WeaponHandlingContext {
  readonly stance: PlayerStance;
  readonly grounded: boolean;
  /**
   * Blocks firing outright, not just widens the cone. The authored animation
   * set has no sprint-and-fire pose, so a round accepted while sprinting has
   * nothing to play; this is a content constraint expressed as a rule.
   */
  readonly sprinting: boolean;
  readonly planarSpeedMetresPerSecond: number;
  readonly breathStabilization: number;
}

export interface WeaponHandlingModifiers {
  readonly dispersionFactor: number;
  readonly recoilPitchFactor: number;
  readonly recoilYawFactor: number;
  readonly recoilRecoveryFactor: number;
  readonly bloomPerShotFactor: number;
  readonly bloomRecoveryFactor: number;
  readonly swayFactor: number;
}

export const DEFAULT_WEAPON_HANDLING_CONTEXT: WeaponHandlingContext = {
  stance: "stand",
  grounded: true,
  sprinting: false,
  planarSpeedMetresPerSecond: 0,
  breathStabilization: 0,
};

export const DEFAULT_WEAPON_HANDLING_MODIFIERS: WeaponHandlingModifiers = {
  dispersionFactor: 1,
  recoilPitchFactor: 1,
  recoilYawFactor: 1,
  recoilRecoveryFactor: 1,
  bloomPerShotFactor: 1,
  bloomRecoveryFactor: 1,
  swayFactor: 1,
};

export const STANCE_HANDLING_MULTIPLIER: Readonly<Record<PlayerStance, number>> = {
  stand: 1,
  crouch: 0.62,
  prone: 0.3,
};

const REFERENCE_MOVEMENT_SPEED_METRES_PER_SECOND = 5.5;
const MAX_MOVEMENT_FACTOR = 2;
const FULL_ADS_HANDLING_FACTOR = 0.12;
const FULL_BREATH_HANDLING_FACTOR = 0.75;

export const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

export function calculateDispersionConeRadians(
  accuracy: WeaponAccuracyDefinition,
  adsProgress: number,
  bloomRadians: number,
  stance: PlayerStance,
  grounded: boolean,
  planarSpeedMetresPerSecond: number,
  breathStabilization: number,
  dispersionFactor: number
): number {
  const ads = clamp01(adsProgress);
  const breath = clamp01(breathStabilization) * ads;
  const movementFactor = Math.min(
    MAX_MOVEMENT_FACTOR,
    finiteNonNegative(planarSpeedMetresPerSecond) / REFERENCE_MOVEMENT_SPEED_METRES_PER_SECOND
  );
  const stanceFactor = STANCE_HANDLING_MULTIPLIER[stance] ?? STANCE_HANDLING_MULTIPLIER.stand;
  const adsFactor = 1 + (FULL_ADS_HANDLING_FACTOR - 1) * ads;
  const breathFactor = 1 + (FULL_BREATH_HANDLING_FACTOR - 1) * breath;
  const groundedHandling =
    (accuracy.hipDispersionRadians * adsFactor +
      accuracy.movementDispersionRadians * movementFactor) *
    stanceFactor *
    breathFactor;
  const standMovingBaseline =
    (accuracy.hipDispersionRadians * adsFactor + accuracy.movementDispersionRadians) *
    breathFactor;
  const handling = grounded
    ? groundedHandling
    : Math.max(groundedHandling + accuracy.airborneDispersionRadians, standMovingBaseline);

  return (
    (accuracy.mechanicalDispersionRadians + handling) * finiteNonNegative(dispersionFactor) +
    finiteNonNegative(bloomRadians)
  );
}
