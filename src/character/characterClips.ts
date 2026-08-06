// Clip vocabulary and selection for the soldier character.
//
// Pure decision logic, deliberately free of Three.js so the 8-way sectoring, gait
// choice, stance mapping and death selection are Node-testable: given a pose
// sample the motor or a snapshot can produce, which named clip should play? The
// names are ground truth from SpecialForcesSoldier_animations.txt; anything a
// caller references is asserted against the loaded GLB at startup.
//
// SHARED, not presentation. It moved out of src/fps for the same reason the
// ballistic core did (docs/12 §3): the authority picks the clip, so both sides
// must agree on WHICH clip a death plays, and a second copy of that table is a
// body falling one way on one machine and another way elsewhere.
//
// The server no longer schedules the respawn from a clip's LENGTH — that coupled
// authority to presentation and drifted, so it is a flat window now (docs/12 §8.0
// amendment). The durations below still matter: the flat window has to clear the
// longest of them, and a test asserts exactly that.

import type { PlayerStance } from "../motor/MotorTypes.ts";

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

// --- death ------------------------------------------------------------------

/**
 * Which side the killing round came FROM, relative to the victim's own facing.
 *
 * "From", not "towards". The clips are named for where the shooter was, so a
 * round travelling north into a victim's chest is a `front` death — getting this
 * backwards plays a forward fall for a shot in the back, which reads as a bug
 * long before anyone works out it is a sign error.
 */
export type DeathDirection = "front" | "back" | "side";

/**
 * Death clips with their own durations, in seconds, from the 30 fps export.
 *
 * The durations are here because nothing on the server can open a GLB, and the
 * respawn window has to CLEAR the longest of them or a body is teleported away
 * mid-fall. The server no longer reads a clip's own length (it schedules a flat
 * window — docs/12 §8.0); a test asserts the window still exceeds this maximum,
 * which is what the numbers are for now. The client should trust the loaded clip
 * over this table, and `deathClipDurationDrift` reports a disagreement.
 *
 * There is no left-side clip in the pack. Per the project's decision one clip
 * serves both sides rather than mirroring at runtime, so `side` is the right-side
 * fall whichever flank the round came from.
 */
export const DEATH_CLIPS = {
  front: { name: "Death_From_The_Front", seconds: 3.47 },
  back: { name: "Death_From_The_Back", seconds: 3.0 },
  side: { name: "Death_From_Right", seconds: 3.33 },
  frontHeadshot: { name: "Death_From_Front_Headshot", seconds: 2.87 },
  backHeadshot: { name: "Death_From_Back_Headshot", seconds: 3.73 },
  crouchingHeadshotFront: { name: "Death_Crouching_Headshot_Front", seconds: 1.93 },
} as const;

export interface DeathSample {
  readonly direction: DeathDirection;
  /** True only once a head zone exists on the capsule; wired, never yet set. */
  readonly headshot: boolean;
  readonly stance: PlayerStance;
}

/**
 * The clip a death plays, and how long it lasts.
 *
 * Returns the duration alongside the name because every caller needs both and
 * looking them up separately is how the two drift apart.
 *
 * The pack has no lateral headshot clip, so a headshot from the flank falls back
 * to the ordinary side death rather than to a front-facing headshot: the fall
 * direction is more legible than the wound, and picking the wrong facing is the
 * more noticeable error.
 */
export function chooseDeathClip(sample: DeathSample): { name: string; seconds: number } {
  const crouched = sample.stance === "crouch" || sample.stance === "prone";
  if (sample.headshot) {
    if (sample.direction === "front") {
      return crouched ? DEATH_CLIPS.crouchingHeadshotFront : DEATH_CLIPS.frontHeadshot;
    }
    if (sample.direction === "back") return DEATH_CLIPS.backHeadshot;
    return DEATH_CLIPS.side;
  }
  if (sample.direction === "front") return DEATH_CLIPS.front;
  if (sample.direction === "back") return DEATH_CLIPS.back;
  return DEATH_CLIPS.side;
}

/**
 * Which side a round came from, given the direction it was TRAVELLING and the
 * victim's yaw.
 *
 * The round's travel direction is negated here, once, so no caller has to
 * remember to. Front and back get the wider arcs because a fall towards or away
 * from the camera reads more clearly than a sideways one, and because the pack
 * has one lateral clip serving both flanks anyway.
 */
export function deathDirectionFrom(
  travelX: number,
  travelZ: number,
  victimYawRadians: number
): DeathDirection {
  const local = { forward: 0, left: 0 };
  // Negated: a round travelling INTO the victim came from the opposite side.
  localizeVelocity(-travelX, -travelZ, victimYawRadians, local);
  // atan2 against the forward axis: 0 is dead ahead, ±π is directly behind.
  const angle = Math.abs(Math.atan2(local.left, local.forward));
  if (angle <= Math.PI / 4) return "front";
  if (angle >= (Math.PI * 3) / 4) return "back";
  return "side";
}

/** Every death clip name, for startup validation against the GLB. */
export function allDeathClips(): string[] {
  return Object.values(DEATH_CLIPS).map((clip) => clip.name);
}

/**
 * Reports death clips whose real duration disagrees with the table above.
 *
 * The table is the only copy the server side can read and it cannot be checked
 * against the GLB there, so the browser — which has both — is where a re-export
 * that changed a clip's length gets caught. What a drift now threatens is the
 * flat respawn window's margin: a clip that grew past it means a body leaves
 * before it finishes falling.
 */
export function deathClipDurationDrift(
  actualSeconds: (name: string) => number | undefined,
  toleranceSeconds = 0.05
): string[] {
  const drifted: string[] = [];
  for (const clip of Object.values(DEATH_CLIPS)) {
    const actual = actualSeconds(clip.name);
    if (actual === undefined) continue;
    if (Math.abs(actual - clip.seconds) > toleranceSeconds) {
      drifted.push(`${clip.name}: table ${clip.seconds}s, clip ${actual.toFixed(2)}s`);
    }
  }
  return drifted;
}

/** Every clip `chooseClip` and `chooseDeathClip` can return, for startup validation. */
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
    ...allDeathClips(),
  ];
}
