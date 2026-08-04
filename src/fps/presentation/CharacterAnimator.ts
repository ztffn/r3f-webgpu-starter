// Drives the soldier's AnimationMixer from pose samples.
//
// Owns clip playback only: crossfades between the loops characterClips.ts
// selects, plays the landing one-shot on the grounded edge, speed-matches
// playback to the authoritative velocity, and pins the Hips so clips pose the
// character in place — the motor (or a snapshot) owns all real movement. The
// non-obvious rig facts here (hips-baked travel, the stripped ':' in bone
// names, no vertical travel in jump clips) come from the reference harness at
// assets/3d/animations/index.html and the pipeline runbook.

import * as THREE from "three/webgpu";
import {
  CLIP_IDLE,
  CLIP_JUMP_DOWN,
  CLIP_JUMP_LOOP,
  chooseClip,
  type LocomotionSample,
} from "../../character/characterClips.ts";

const CROSSFADE_SECONDS = 0.2;
const LANDING_FADE_SECONDS = 0.12;
/** A death is abrupt. Longer than this and the body eases out of a run into a
 * fall, which reads as a stumble rather than as being shot. */
const DEATH_FADE_SECONDS = 0.06;
/** The landing one-shot only plays after a real fall ending near-stationary;
 * it is a planted-feet clip, so a fast or trivial landing must skip it or the
 * body slides metres on frozen legs. */
const MIN_AIRTIME_FOR_LANDING_SECONDS = 0.3;
const LANDING_CANCEL_SPEED = 1.5;
/** Walk/run split moves ±10% with the current gait so a speed sitting on the
 * boundary cannot alternate two perpetually-restarting clips. */
const GAIT_HYSTERESIS = 0.1;
/** Runtime name of the root motion bone — the glTF export strips the ':' from
 * Blender's "mixamorig:Hips". */
export const HIPS_BONE = "mixamorigHips";
/** Speed-match clamp so velocity mismatch never becomes slow motion or thrash. */
const MIN_TIME_SCALE = 0.6;
const MAX_TIME_SCALE = 1.6;
/** Walk/run split fallback when the clips carry no measurable root motion. */
const FALLBACK_RUN_THRESHOLD = 3;

/** Per-clip baked feet speeds and the derived walk/run split. A pure function
 * of the shared clip array, so compute it once at asset load and hand it to
 * every animator instead of rescanning 49 clips per spawned character. */
export interface ClipSpeeds {
  readonly naturalSpeed: ReadonlyMap<string, number>;
  readonly runSpeedThreshold: number;
}

export function measureClipSpeeds(
  root: THREE.Object3D,
  animations: readonly THREE.AnimationClip[]
): ClipSpeeds {
  const hips = root.getObjectByName(HIPS_BONE);
  const hipsTrack = hips === undefined ? null : `${hips.name}.position`;
  const naturalSpeed = new Map<string, number>();
  for (const clip of animations) {
    const track =
      hipsTrack === null ? undefined : clip.tracks.find((t) => t.name === hipsTrack);
    if (track === undefined || clip.duration <= 0) {
      naturalSpeed.set(clip.name, 0);
      continue;
    }
    const values = track.values;
    const n = values.length;
    naturalSpeed.set(
      clip.name,
      Math.hypot(values[n - 3]! - values[0]!, values[n - 1]! - values[2]!) / clip.duration
    );
  }
  const walk = naturalSpeed.get("Walk_Forward") ?? 0;
  const run = naturalSpeed.get("Run_Forward") ?? 0;
  return {
    naturalSpeed,
    runSpeedThreshold: walk > 0 && run > walk ? (walk + run) / 2 : FALLBACK_RUN_THRESHOLD,
  };
}

export class CharacterAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly clips = new Map<string, THREE.AnimationClip>();
  private readonly actions = new Map<string, THREE.AnimationAction>();
  /** Metres per second each clip's feet were animated for, from its baked
   * Hips travel — the harness technique that kills hand-tuned speed constants. */
  private readonly naturalSpeed: ReadonlyMap<string, number>;
  private readonly hips: THREE.Object3D | null;
  private readonly hipsRestX: number = 0;
  private readonly hipsRestZ: number = 0;
  private readonly runSpeedThreshold: number;

  private current: THREE.AnimationAction | null = null;
  /** The playing clip's baked feet speed, cached at switch so the steady-state
   * frame path is one multiply instead of a Map lookup. */
  private currentNaturalSpeed = 0;
  /** The landing one-shot is in control until it finishes. */
  private landing = false;
  /** Dead: the death one-shot owns the body until `revive`. */
  private dead = false;
  private deathClip: string | null = null;
  private wasGrounded = true;
  private airborneSeconds = 0;
  private runningGait = false;

  constructor(
    root: THREE.Object3D,
    animations: readonly THREE.AnimationClip[],
    clipSpeeds?: ClipSpeeds
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of animations) this.clips.set(clip.name, clip);

    this.hips = root.getObjectByName(HIPS_BONE) ?? null;
    if (this.hips !== null) {
      this.hipsRestX = this.hips.position.x;
      this.hipsRestZ = this.hips.position.z;
    }

    const speeds = clipSpeeds ?? measureClipSpeeds(root, animations);
    this.naturalSpeed = speeds.naturalSpeed;
    this.runSpeedThreshold = speeds.runSpeedThreshold;

    this.mixer.addEventListener("finished", (event) => {
      if (this.landing && event.action === this.actions.get(CLIP_JUMP_DOWN)) {
        this.landing = false;
      }
    });

    this.play(CLIP_IDLE, 0);
  }

  /**
   * Starts a death, and holds its final pose until `revive`.
   *
   * Idempotent per clip: a repeated call with the same clip is ignored, because
   * the snapshot that says a player is dead arrives every patch and restarting
   * the fall twenty times a second would freeze the body at frame zero.
   */
  die(clipName: string): void {
    if (this.dead && this.deathClip === clipName) return;
    this.dead = true;
    this.deathClip = clipName;
    this.landing = false;
    this.playOnce(clipName, DEATH_FADE_SECONDS);
  }

  /** Back on their feet: locomotion takes the body back on the next update. */
  revive(): void {
    if (!this.dead) return;
    this.dead = false;
    this.deathClip = null;
    // Straight to an idle rather than waiting for the next selection, so a
    // respawn cannot render one frame of the corpse standing at the spawn point.
    this.play(CLIP_IDLE, 0);
  }

  get isDead(): boolean {
    return this.dead;
  }

  update(deltaSeconds: number, sample: LocomotionSample): void {
    if (this.dead) {
      // Locomotion is not consulted at all while dead. The body is still
      // receiving snapshots — a corpse has a position and a stance — and letting
      // chooseClip run would fade a walk cycle over the fall.
      this.mixer.update(deltaSeconds);
      // NO hips reset here, deliberately. Everywhere else the baked travel is
      // cancelled so clips pose in place, but a death is the one clip whose
      // travel is the point: a body that falls forward should end up where it
      // fell, not standing on the spot it died.
      return;
    }
    if (!sample.grounded) {
      // Going airborne cancels a landing that was still playing.
      this.landing = false;
      this.airborneSeconds += deltaSeconds;
    }

    if (sample.grounded && !this.wasGrounded) {
      if (
        this.airborneSeconds > MIN_AIRTIME_FOR_LANDING_SECONDS &&
        sample.speed < LANDING_CANCEL_SPEED
      ) {
        this.landing = true;
        this.playOnce(CLIP_JUMP_DOWN, LANDING_FADE_SECONDS);
      }
      this.airborneSeconds = 0;
    }
    this.wasGrounded = sample.grounded;
    // A landing that starts moving hands control back to locomotion at once.
    if (this.landing && sample.speed >= LANDING_CANCEL_SPEED) this.landing = false;

    if (!this.landing) {
      const threshold =
        this.runSpeedThreshold *
        (this.runningGait ? 1 - GAIT_HYSTERESIS : 1 + GAIT_HYSTERESIS);
      const name = chooseClip(sample, threshold);
      this.runningGait = name.startsWith("Run_") || name.startsWith("Sprint_");
      this.play(name, name === CLIP_JUMP_LOOP ? LANDING_FADE_SECONDS : CROSSFADE_SECONDS);
      if (this.current !== null) {
        this.current.timeScale =
          this.currentNaturalSpeed > 0.1
            ? Math.min(
                MAX_TIME_SCALE,
                Math.max(MIN_TIME_SCALE, sample.speed / this.currentNaturalSpeed)
              )
            : 1;
      }
    }

    this.mixer.update(deltaSeconds);

    // Cancel the baked travel so clips only ever pose in place; the vertical
    // is left alone because Hips Y is the crouch drop and the walk bob — pose,
    // not drift. (Death clips would be exempt; none are wired yet.)
    if (this.hips !== null) {
      this.hips.position.x = this.hipsRestX;
      this.hips.position.z = this.hipsRestZ;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
  }

  private action(name: string): THREE.AnimationAction | null {
    const existing = this.actions.get(name);
    if (existing !== undefined) return existing;
    const clip = this.clips.get(name);
    if (clip === undefined) return null;
    const created = this.mixer.clipAction(clip);
    this.actions.set(name, created);
    return created;
  }

  private play(name: string, fadeSeconds: number): void {
    const next = this.action(name);
    if (next === null || next === this.current) return;
    // Carry the stride phase into the incoming loop: an 8-way direction change
    // continues the gait cycle instead of re-planting the feet at frame 0.
    const phase = this.current === null ? 0 : this.current.time;
    next.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveWeight(1).fadeIn(fadeSeconds).play();
    next.time = phase % next.getClip().duration;
    if (this.current !== null) this.current.fadeOut(fadeSeconds);
    this.current = next;
    this.currentNaturalSpeed = this.naturalSpeed.get(name) ?? 0;
  }

  private playOnce(name: string, fadeSeconds: number): void {
    const next = this.action(name);
    if (next === null) {
      this.landing = false;
      return;
    }
    next.reset().setLoop(THREE.LoopOnce, 1).setEffectiveWeight(1).fadeIn(fadeSeconds).play();
    // Hold the final pose when the one-shot ends: without the clamp, three.js
    // disables the action on its last frame, total mixer weight hits zero, and
    // the skeleton flashes to the bind pose before the next loop fades in.
    next.clampWhenFinished = true;
    next.timeScale = 1;
    if (this.current !== null && this.current !== next) this.current.fadeOut(fadeSeconds);
    this.current = next;
    this.currentNaturalSpeed = 0;
  }
}
