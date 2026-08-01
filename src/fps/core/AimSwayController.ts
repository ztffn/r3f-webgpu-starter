import type { PlayerStance } from "./PlayerMotor";

const HIP_ANGULAR_AMPLITUDE = 0.012;
const ADS_ANGULAR_AMPLITUDE = 0.0032;
const HIP_POSITION_AMPLITUDE = 0.009;
const ADS_POSITION_AMPLITUDE = 0.0018;
const HELD_BREATH_MULTIPLIER = 0.24;
const BREATH_RESPONSE = 14;
const MAX_DELTA_SECONDS = 0.1;

export const STANCE_SWAY_MULTIPLIER: Readonly<Record<PlayerStance, number>> = {
  stand: 1,
  crouch: 0.62,
  prone: 0.3,
};

export interface AimSwayInput {
  readonly stance: PlayerStance;
  readonly adsBlend: number;
  readonly holdingBreath: boolean;
  readonly handlingMultiplier?: number;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const damp = (current: number, target: number, response: number, delta: number): number =>
  current + (target - current) * (1 - Math.exp(-response * delta));

/** Deterministic gameplay sway shared by authoritative aim and presentation. */
export class AimSwayController {
  phaseSeconds = 0;
  breathStabilization = 0;
  yawRadians = 0;
  pitchRadians = 0;
  positionXMetres = 0;
  positionYMetres = 0;
  angularAmplitudeRadians = HIP_ANGULAR_AMPLITUDE;

  update(deltaSeconds: number, input: AimSwayInput): void {
    const delta = Math.min(
      MAX_DELTA_SECONDS,
      Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0)
    );
    const adsBlend = clamp01(input.adsBlend);
    const breathTarget = input.holdingBreath && adsBlend > 0 ? 1 : 0;
    this.breathStabilization = damp(
      this.breathStabilization,
      breathTarget,
      BREATH_RESPONSE,
      delta
    );
    this.phaseSeconds += delta;

    const stanceMultiplier = STANCE_SWAY_MULTIPLIER[input.stance] ?? STANCE_SWAY_MULTIPLIER.stand;
    const breathMultiplier =
      1 + (HELD_BREATH_MULTIPLIER - 1) * this.breathStabilization;
    const handlingMultiplier = Number.isFinite(input.handlingMultiplier)
      ? Math.max(0, input.handlingMultiplier ?? 1)
      : 1;
    const combinedMultiplier = stanceMultiplier * breathMultiplier * handlingMultiplier;
    this.angularAmplitudeRadians =
      (HIP_ANGULAR_AMPLITUDE +
        (ADS_ANGULAR_AMPLITUDE - HIP_ANGULAR_AMPLITUDE) * adsBlend) *
      combinedMultiplier;
    const positionAmplitude =
      (HIP_POSITION_AMPLITUDE +
        (ADS_POSITION_AMPLITUDE - HIP_POSITION_AMPLITUDE) * adsBlend) *
      combinedMultiplier;

    const phase = this.phaseSeconds;
    this.yawRadians =
      (Math.sin(phase * 1.15) + Math.sin(phase * 0.41) * 0.35) *
      this.angularAmplitudeRadians;
    this.pitchRadians =
      (Math.cos(phase * 1.43) + Math.sin(phase * 0.57) * 0.25) *
      this.angularAmplitudeRadians *
      0.72;
    this.positionXMetres = Math.sin(phase * 1.15) * positionAmplitude;
    this.positionYMetres = Math.cos(phase * 1.43) * positionAmplitude * 0.55;
  }

  reset(): void {
    this.phaseSeconds = 0;
    this.breathStabilization = 0;
    this.yawRadians = 0;
    this.pitchRadians = 0;
    this.positionXMetres = 0;
    this.positionYMetres = 0;
    this.angularAmplitudeRadians = HIP_ANGULAR_AMPLITUDE;
  }
}
