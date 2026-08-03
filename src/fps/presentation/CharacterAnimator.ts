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
} from "./characterClips.ts";

const CROSSFADE_SECONDS = 0.2;
const LANDING_FADE_SECONDS = 0.12;
/** Speed-match clamp so velocity mismatch never becomes slow motion or thrash. */
const MIN_TIME_SCALE = 0.6;
const MAX_TIME_SCALE = 1.6;
/** Walk/run split fallback when the clips carry no measurable root motion. */
const FALLBACK_RUN_THRESHOLD = 3;

export class CharacterAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly clips = new Map<string, THREE.AnimationClip>();
  private readonly actions = new Map<string, THREE.AnimationAction>();
  /** Metres per second each clip's feet were animated for, from its baked
   * Hips travel — the harness technique that kills hand-tuned speed constants. */
  private readonly naturalSpeed = new Map<string, number>();
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
  private wasGrounded = true;

  constructor(root: THREE.Object3D, animations: readonly THREE.AnimationClip[]) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of animations) this.clips.set(clip.name, clip);

    // glTF export strips the ':' from Blender's "mixamorig:Hips", so the node
    // arrives as "mixamorigHips" — resolve by suffix, never by exact name.
    this.hips = findBySuffix(root, /Hips$/);
    if (this.hips !== null) {
      this.hipsRestX = this.hips.position.x;
      this.hipsRestZ = this.hips.position.z;
    }

    // Every locomotion clip bakes its travel into the Hips; first-to-last
    // sample over duration is the exact speed the feet were animated for.
    const hipsTrack = this.hips === null ? null : `${this.hips.name}.position`;
    for (const [name, clip] of this.clips) {
      const track =
        hipsTrack === null ? undefined : clip.tracks.find((t) => t.name === hipsTrack);
      if (track === undefined || clip.duration <= 0) {
        this.naturalSpeed.set(name, 0);
        continue;
      }
      const values = track.values;
      const n = values.length;
      const dx = values[n - 3]! - values[0]!;
      const dz = values[n - 1]! - values[2]!;
      this.naturalSpeed.set(name, Math.hypot(dx, dz) / clip.duration);
    }

    const walk = this.naturalSpeed.get("Walk_Forward") ?? 0;
    const run = this.naturalSpeed.get("Run_Forward") ?? 0;
    this.runSpeedThreshold = walk > 0 && run > walk ? (walk + run) / 2 : FALLBACK_RUN_THRESHOLD;

    this.mixer.addEventListener("finished", (event) => {
      if (this.landing && event.action === this.actions.get(CLIP_JUMP_DOWN)) {
        this.landing = false;
      }
    });

    this.play(CLIP_IDLE, 0);
  }

  update(deltaSeconds: number, sample: LocomotionSample): void {
    // Going airborne cancels a landing that was still playing.
    if (!sample.grounded) this.landing = false;

    if (sample.grounded && !this.wasGrounded) {
      this.landing = true;
      this.playOnce(CLIP_JUMP_DOWN, LANDING_FADE_SECONDS);
    }
    this.wasGrounded = sample.grounded;

    if (!this.landing) {
      const name = chooseClip(sample, this.runSpeedThreshold);
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
    next.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveWeight(1).fadeIn(fadeSeconds).play();
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
    next.timeScale = 1;
    if (this.current !== null && this.current !== next) this.current.fadeOut(fadeSeconds);
    this.current = next;
    this.currentNaturalSpeed = 0;
  }
}

/** Collected through an array because TS does not track assignments made
 * inside a traverse callback and narrows a plain local back to null. */
function findBySuffix(root: THREE.Object3D, suffix: RegExp): THREE.Object3D | null {
  const matches: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (matches.length === 0 && suffix.test(object.name)) matches.push(object);
  });
  return matches[0] ?? null;
}
