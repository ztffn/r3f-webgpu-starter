// Clip vocabulary and selection for the soldier character.
//
// Pure decision logic, deliberately free of Three.js so the 8-way sectoring,
// gait choice and stance mapping are Node-testable: given a pose sample the
// motor or a snapshot can produce, which named clip should play? The names
// are ground truth from SpecialForcesSoldier_animations.txt; anything a
// caller references is asserted against the loaded GLB at startup.

import type { PlayerStance } from "../../motor/MotorTypes.ts";

/** Below this planar speed the character is considered standing still. */
export const IDLE_SPEED = 0.3;

export const CLIP_IDLE = "Idle";
export const CLIP_IDLE_AIM = "Idle_Aiming";
export const CLIP_IDLE_CROUCH = "Idle_Crouching";
export const CLIP_IDLE_CROUCH_AIM = "Idle_Crouching_Aiming";
export const CLIP_JUMP_LOOP = "Jump_Loop";
export const CLIP_JUMP_DOWN = "Jump_Down";

/**
 * 8-way suffixes in sector order, 45° each, centred on straight ahead.
 * The gait tables are prebuilt so the frame loop only ever indexes into
 * interned constants — a template string per frame per character is exactly
 * the allocation the zero-alloc loop convention forbids.
 */
const SUFFIXES = [
  "Forward",
  "Forward_Left",
  "Left",
  "Backward_Left",
  "Backward",
  "Backward_Right",
  "Right",
  "Forward_Right",
] as const;

const WALK_CLIPS = SUFFIXES.map((suffix) => `Walk_${suffix}`);
const RUN_CLIPS = SUFFIXES.map((suffix) => `Run_${suffix}`);
const SPRINT_CLIPS = SUFFIXES.map((suffix) => `Sprint_${suffix}`);
const CROUCH_WALK_CLIPS = SUFFIXES.map((suffix) => `Walk_Crouching_${suffix}`);

/**
 * The pose facts clip selection needs. Derivable from a local MotorState and
 * from a remote snapshot alike — that equivalence is the whole design.
 */
export interface LocomotionSample {
  /** Planar speed, m/s. */
  readonly speed: number;
  /** Velocity component along the character's facing, m/s. */
  readonly forward: number;
  /** Velocity component to the character's left, m/s. */
  readonly left: number;
  readonly stance: PlayerStance;
  readonly grounded: boolean;
  readonly sprinting: boolean;
  /** Resolved ADS state — what raises the rifle into the aiming idles. */
  readonly aiming: boolean;
}

/**
 * Motor yaw 0 faces world -Z and left is world -X (docs/12 §4 basis). Resolves
 * a world planar velocity into the character-local components selection needs,
 * written into `out` so the frame loop allocates nothing.
 */
export function localizeVelocity(
  velocityX: number,
  velocityZ: number,
  yawRadians: number,
  out: { forward: number; left: number }
): void {
  const forwardX = -Math.sin(yawRadians);
  const forwardZ = -Math.cos(yawRadians);
  out.forward = velocityX * forwardX + velocityZ * forwardZ;
  // left = up x forward
  out.left = velocityX * forwardZ - velocityZ * forwardX;
}

/** Which of the 8 sectors (index into the suffix order) matches this movement. */
export function directionSector(forward: number, left: number): number {
  const angle = Math.atan2(left, forward);
  // `& 7` maps every int32 — negative sectors included — into 0..7.
  return Math.round(angle / (Math.PI / 4)) & 7;
}

/** The directional suffix for a movement, for tests and diagnostics. */
export function directionSuffix(forward: number, left: number): string {
  return SUFFIXES[directionSector(forward, left)]!;
}

/**
 * Chooses the looping clip for a pose sample.
 *
 * `runSpeedThreshold` is the walk/run split in m/s. It is a parameter rather
 * than a constant because the right value is measured from the clips' own
 * baked root motion at load time (halfway between the walk and run clips'
 * natural speeds), not hand-tuned.
 *
 * Prone has no clips in the pack; it deliberately falls back to the crouch
 * set (the runbook's §5 bake path is how prone clips arrive later).
 */
export function chooseClip(sample: LocomotionSample, runSpeedThreshold: number): string {
  if (!sample.grounded) return CLIP_JUMP_LOOP;

  const crouched = sample.stance === "crouch" || sample.stance === "prone";
  if (sample.speed < IDLE_SPEED) {
    if (crouched) return sample.aiming ? CLIP_IDLE_CROUCH_AIM : CLIP_IDLE_CROUCH;
    return sample.aiming ? CLIP_IDLE_AIM : CLIP_IDLE;
  }

  const sector = directionSector(sample.forward, sample.left);
  if (crouched) return CROUCH_WALK_CLIPS[sector]!;
  if (sample.sprinting) return SPRINT_CLIPS[sector]!;
  return sample.speed >= runSpeedThreshold ? RUN_CLIPS[sector]! : WALK_CLIPS[sector]!;
}

/** Every clip `chooseClip` can return, for startup validation against the GLB. */
export function allSelectableClips(): string[] {
  return [
    CLIP_IDLE,
    CLIP_IDLE_AIM,
    CLIP_IDLE_CROUCH,
    CLIP_IDLE_CROUCH_AIM,
    CLIP_JUMP_LOOP,
    CLIP_JUMP_DOWN,
    ...WALK_CLIPS,
    ...RUN_CLIPS,
    ...SPRINT_CLIPS,
    ...CROUCH_WALK_CLIPS,
  ];
}
