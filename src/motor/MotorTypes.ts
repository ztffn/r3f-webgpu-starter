// Serializable command and state types for the shared character motor.
//
// Everything here is plain data with a tick identifier so the identical motor
// runs client-side for prediction and server-side for authority. No Three.js,
// no DOM, no Rapier types leak into this file — it is the wire contract, and it
// must stay readable by a Node server that has no renderer.

/** Minimal terrain contract. `Heightfield` satisfies this structurally. */
export interface MotorHeightSource {
  /** Metres between adjacent elevation samples. */
  readonly cellSize: number;
  /** Bilinear elevation at world (x, z). Must wrap, never clamp. */
  sample(x: number, z: number): number;
}

export type PlayerStance = "stand" | "crouch" | "prone";

/**
 * Input bits. A bitfield rather than booleans so a command packs into a few
 * bytes on the wire. Digital only — DF2 is a keyboard game, and analog axes
 * would need a wider command that no current input path produces.
 */
export const MotorInput = {
  Forward: 1 << 0,
  Back: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Jump: 1 << 4,
  Sprint: 1 << 5,
  Crouch: 1 << 6,
  Prone: 1 << 7,
  /**
   * Aim intent, not the weapon's resolved ADS state.
   *
   * It has to ride in the command rather than being read from the weapon,
   * because anything that changes movement must be reproducible by a server
   * replaying the command stream. A weapon that refuses to enter ADS still
   * slows the player, which is the correct trade: movement stays deterministic.
   */
  Ads: 1 << 8,
  /** Reload intent. Same contract as `Ads`: intent, never resolved weapon state. */
  Reloading: 1 << 9,
} as const;

/** Contact conditions the motor observed during a step. */
export const MotorContact = {
  Grounded: 1 << 0,
  /** A stand-up was requested but blocked by overhead geometry. */
  CeilingBlocked: 1 << 1,
  /** Horizontal movement was reduced by a wall. */
  WallContact: 1 << 2,
  /** Standing on ground steeper than the climb limit. */
  SteepSlope: 1 << 3,
} as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * One tick of player intent. Look angles are absolute rather than deltas: the
 * client owns the look curve, and absolute angles make a replayed command
 * stream reproduce the same aim regardless of how many commands were dropped.
 */
export interface PlayerCommand {
  readonly tick: number;
  readonly buttons: number;
  readonly yawRadians: number;
  readonly pitchRadians: number;
}

/**
 * Authoritative motor output. `position` is the FEET, not the eye — the eye is
 * presentation derived from stance, and putting feet on the wire keeps the
 * state independent of stance-transition blending.
 */
export interface MotorState {
  tick: number;
  readonly position: Vec3;
  readonly velocity: Vec3;
  yawRadians: number;
  pitchRadians: number;
  stance: PlayerStance;
  /** What `stance` is blending away from. Carried so a remote snapshot can blend too. */
  previousStance: PlayerStance;
  /** 0 = fully in `previousStance`, 1 = fully in `stance`. Presentation only. */
  stanceProgress: number;
  grounded: boolean;
  /** Resolved, not the raw input bit: aiming or crouching suppresses it. */
  sprinting: boolean;
  /** ADS intent as the motor consumed it, mirrored into state so a remote can
   * pose from it (raise the rifle) without weapon state on the wire. */
  aiming: boolean;
  contactFlags: number;
}

export interface StanceDimensions {
  /** Total body height in metres. */
  readonly height: number;
  /** Capsule radius in metres. */
  readonly radius: number;
  /** Eye height above the feet in metres. */
  readonly eye: number;
  /** Ground speed cap in metres per second. */
  readonly speed: number;
}

export interface MotorTuning {
  readonly fixedTimestepSeconds: number;
  readonly gravityMetresPerSecondSquared: number;
  readonly jumpSpeedMetresPerSecond: number;
  readonly sprintMultiplier: number;
  /** Speed scale while aiming. Aiming and running are meant to be a trade. */
  readonly adsMultiplier: number;
  /** Speed scale while reloading. Reloading on the move should cost something. */
  readonly reloadMultiplier: number;
  /** Ground acceleration, metres per second squared. */
  readonly acceleration: number;
  /** Ground deceleration, metres per second squared. */
  readonly deceleration: number;
  /** Fraction of ground acceleration usable while airborne. */
  readonly airControl: number;
  readonly maxSlopeClimbRadians: number;
  readonly minSlopeSlideRadians: number;
  readonly maxStepHeightMetres: number;
  readonly snapToGroundMetres: number;
  /** Collider skin width. Rapier needs this non-zero to stay stable. */
  readonly contactOffsetMetres: number;
  /** Seconds to blend between stances. Presentation only; collision snaps. */
  readonly stanceBlendSeconds: number;
  readonly stances: Readonly<Record<PlayerStance, StanceDimensions>>;
}

/**
 * Eye heights match `STANCE_EYE` in the terrain spike's camera rig and
 * docs/04 §4.2; speeds match its on-foot walk rates. Both are stated in real
 * metres, so they survive the pending terrain scale calibration unchanged.
 */
export const DEFAULT_MOTOR_TUNING: MotorTuning = {
  fixedTimestepSeconds: 1 / 60,
  gravityMetresPerSecondSquared: 9.81,
  jumpSpeedMetresPerSecond: 4.5,
  sprintMultiplier: 1.6,
  adsMultiplier: 0.45,
  reloadMultiplier: 0.6,
  acceleration: 45,
  deceleration: 60,
  airControl: 0.25,
  // Deliberately permissive: DF2 let you walk almost anything, and extracted
  // heightmaps are steeper per cell than real landscape.
  //
  // The limit is SOFT. Speed falls off with steepness rather than gating, so
  // ground past it is slow rather than impassable — do not read this as a hard
  // edge the player cannot cross.
  //
  // It also compensates for the still-uncalibrated vertical scale
  // (`HEIGHT_SCALE`, `METERS_PER_TEXEL`); revisit downward once that is fixed.
  maxSlopeClimbRadians: (75 * Math.PI) / 180,
  minSlopeSlideRadians: (82 * Math.PI) / 180,
  maxStepHeightMetres: 0.45,
  snapToGroundMetres: 0.35,
  contactOffsetMetres: 0.02,
  stanceBlendSeconds: 0.18,
  stances: {
    stand: { height: 1.8, radius: 0.35, eye: 1.7, speed: 5.5 },
    crouch: { height: 1.0, radius: 0.35, eye: 0.95, speed: 2.4 },
    prone: { height: 0.5, radius: 0.25, eye: 0.35, speed: 1.6 },
  },
};

export function createMotorState(): MotorState {
  return {
    tick: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yawRadians: 0,
    pitchRadians: 0,
    stance: "stand",
    previousStance: "stand",
    stanceProgress: 1,
    grounded: false,
    sprinting: false,
    aiming: false,
    contactFlags: 0,
  };
}

export function createPlayerCommand(tick = 0): PlayerCommand {
  return { tick, buttons: 0, yawRadians: 0, pitchRadians: 0 };
}

/**
 * A stance dimension blended across the current transition. Pure, so a client
 * can call it on an interpolated snapshot of a remote player it does not
 * simulate.
 */
export function blendedStanceDimension(
  state: MotorState,
  tuning: MotorTuning,
  dimension: "height" | "radius" | "eye"
): number {
  const from = tuning.stances[state.previousStance][dimension];
  const to = tuning.stances[state.stance][dimension];
  const t = state.stanceProgress < 0 ? 0 : state.stanceProgress > 1 ? 1 : state.stanceProgress;
  return from + (to - from) * t;
}

/** Eye height above the feet for a state's blended stance. */
export function eyeHeightFor(state: MotorState, tuning: MotorTuning): number {
  return blendedStanceDimension(state, tuning, "eye");
}
