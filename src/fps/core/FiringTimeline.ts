// One trigger-to-projectile simulation timeline for a single render frame.
// It walks accepted weapon events in cadence order, advances gameplay sway and
// the projectile solver to each acceptance boundary, freezes the interpolated
// player pose there, and composes the sight, mean bore, and projectile
// directions for that round. Presentation hosts only supply poses and observe.

import * as THREE from "three/webgpu";
import type { PlayerStance } from "./PlayerMotor.ts";
import { WeaponAimComposer } from "./WeaponAimComposer.ts";
import type { AimSwayController } from "./AimSwayController.ts";
import type { BallisticShot } from "../combat/BallisticProjectileSystem.ts";
import type { LoadoutEvent } from "../weapons/LoadoutSystem.ts";
import { WEAPON_UPDATE_MAX_SECONDS } from "../weapons/WeaponSystem.ts";

/**
 * Weapons, sway, and projectiles must share one clock, so the whole gameplay
 * path uses the weapon runtime's own hitch bound rather than three different
 * per-system caps.
 */
export const MAX_SIMULATION_FRAME_SECONDS = WEAPON_UPDATE_MAX_SECONDS;

export function clampSimulationDelta(deltaSeconds: number): number {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return 0;
  return Math.min(deltaSeconds, MAX_SIMULATION_FRAME_SECONDS);
}

type AcceptedShotEvent = Extract<LoadoutEvent, { type: "shot" }>;

/** Turret seam. Only the sight-to-bore adjustment is needed on this path. */
export interface SightAdjustment {
  applyToSightDirection(sightDirection: THREE.Vector3Like, target: THREE.Vector3): THREE.Vector3;
}

export interface ProjectileSpawner {
  update(deltaSeconds: number): void;
  spawn(shot: BallisticShot): boolean;
}

export interface WeaponEventSource {
  drainEvents(visitor: (event: LoadoutEvent) => void): void;
}

export interface FiringTimelineDependencies {
  readonly ballistics: ProjectileSpawner;
  readonly sway: AimSwayController;
  /** Resolved per accepted round, so a mid-frame equip cannot mis-attribute zeroing. */
  readonly sightAdjustmentFor: (weaponId: string) => SightAdjustment;
}

/**
 * Player state sampled at both ends of the frame. Sub-frame acceptance
 * boundaries interpolate between them, which is the best available
 * reconstruction of motion the host only observes at frame edges.
 */
export interface FiringTimelineFrame {
  deltaSeconds: number;
  readonly startPosition: THREE.Vector3;
  readonly endPosition: THREE.Vector3;
  readonly startOrientation: THREE.Quaternion;
  readonly endOrientation: THREE.Quaternion;
  stance: PlayerStance;
  holdingBreath: boolean;
  swayHandlingMultiplier: number;
  adsProgressStart: number;
  adsProgressEnd: number;
  captureTrace: boolean;
}

/**
 * Frozen state of one accepted round. The vectors are scratch storage reused
 * across rounds; observers must copy anything they retain.
 */
export interface AcceptedShotView {
  readonly weaponId: string;
  readonly sequence: number;
  readonly acceptedAtOffsetSeconds: number;
  readonly origin: THREE.Vector3;
  readonly sightDirection: THREE.Vector3;
  readonly boreDirection: THREE.Vector3;
  readonly projectileDirection: THREE.Vector3;
  readonly spawned: boolean;
}

export interface FiringTimelineHandlers {
  onShot?(shot: AcceptedShotView, event: AcceptedShotEvent): void;
  onEvent?(event: Exclude<LoadoutEvent, { type: "shot" }>): void;
}

export function createFiringTimelineFrame(): FiringTimelineFrame {
  return {
    deltaSeconds: 0,
    startPosition: new THREE.Vector3(),
    endPosition: new THREE.Vector3(),
    startOrientation: new THREE.Quaternion(),
    endOrientation: new THREE.Quaternion(),
    stance: "stand",
    holdingBreath: false,
    swayHandlingMultiplier: 1,
    adsProgressStart: 0,
    adsProgressEnd: 0,
    captureTrace: false,
  };
}

export class FiringTimeline {
  /**
   * Milliseconds the last `runFrame` spent inside the projectile solver alone.
   * The host times the whole call, so the difference is timeline plus handler
   * overhead; keeping them apart makes a regression in either attributable.
   */
  projectileMilliseconds = 0;

  private readonly dependencies: FiringTimelineDependencies;
  private readonly composer = new WeaponAimComposer();
  private readonly pending: LoadoutEvent[] = [];
  private readonly baseQuaternion = new THREE.Quaternion();
  private readonly meanQuaternion = new THREE.Quaternion();
  private readonly swayInput = {
    stance: "stand" as PlayerStance,
    adsBlend: 0,
    holdingBreath: false,
    handlingMultiplier: 1,
  };
  private readonly view = {
    weaponId: "",
    sequence: 0,
    acceptedAtOffsetSeconds: 0,
    origin: new THREE.Vector3(),
    sightDirection: new THREE.Vector3(),
    boreDirection: new THREE.Vector3(),
    projectileDirection: new THREE.Vector3(),
    spawned: false,
  };

  constructor(dependencies: FiringTimelineDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * Drains the frame's accepted events and replays them chronologically. Each
   * projectile receives only the simulation time after its own acceptance
   * boundary, so render cadence cannot change when or where a round starts.
   */
  runFrame(
    frame: FiringTimelineFrame,
    source: WeaponEventSource,
    handlers: FiringTimelineHandlers = {}
  ): void {
    const delta = clampSimulationDelta(frame.deltaSeconds);
    this.projectileMilliseconds = 0;
    this.pending.length = 0;
    source.drainEvents((event) => {
      this.pending.push(event);
    });

    let cursor = 0;
    for (const event of this.pending) {
      if (event.type !== "shot") {
        handlers.onEvent?.(event);
        continue;
      }
      const acceptedAt = Math.min(
        Math.max(
          Number.isFinite(event.acceptedAtOffsetSeconds) ? event.acceptedAtOffsetSeconds : 0,
          cursor
        ),
        delta
      );
      this.advance(frame, delta, acceptedAt - cursor, acceptedAt);
      cursor = acceptedAt;
      this.resolveShot(frame, delta, cursor, event, handlers);
    }
    this.advance(frame, delta, delta - cursor, delta, true);
    this.pending.length = 0;
  }

  private advance(
    frame: FiringTimelineFrame,
    delta: number,
    stepSeconds: number,
    atSeconds: number,
    force = false
  ): void {
    const step = Math.max(0, stepSeconds);
    if (step <= 0 && !force) return;
    // ADS progress ramps linearly inside the weapon, so sampling it at the end
    // of each slice keeps sway amplitude a function of absolute time.
    this.swayInput.adsBlend = THREE.MathUtils.lerp(
      frame.adsProgressStart,
      frame.adsProgressEnd,
      delta > 0 ? atSeconds / delta : 1
    );
    this.swayInput.stance = frame.stance;
    this.swayInput.holdingBreath = frame.holdingBreath;
    this.swayInput.handlingMultiplier = frame.swayHandlingMultiplier;
    this.dependencies.sway.update(step, this.swayInput);
    const startedAt = performance.now();
    this.dependencies.ballistics.update(step);
    this.projectileMilliseconds += performance.now() - startedAt;
  }

  private resolveShot(
    frame: FiringTimelineFrame,
    delta: number,
    atSeconds: number,
    event: AcceptedShotEvent,
    handlers: FiringTimelineHandlers
  ): void {
    const fraction = delta > 0 ? atSeconds / delta : 1;
    const view = this.view;
    view.origin.lerpVectors(frame.startPosition, frame.endPosition, fraction);
    this.baseQuaternion.slerpQuaternions(
      frame.startOrientation,
      frame.endOrientation,
      fraction
    );
    const sway = this.dependencies.sway;
    this.composer.composeQuaternion(
      this.baseQuaternion,
      sway.yawRadians,
      sway.pitchRadians,
      this.baseQuaternion
    );
    this.composer.composeQuaternion(
      this.baseQuaternion,
      event.recoilOffsetYawRadians,
      event.recoilOffsetPitchRadians,
      this.meanQuaternion
    );
    this.composer.directionFromQuaternion(this.meanQuaternion, view.sightDirection);
    this.dependencies
      .sightAdjustmentFor(event.weaponId)
      .applyToSightDirection(view.sightDirection, view.boreDirection);
    this.composer.offsetDirection(
      view.boreDirection,
      event.dispersionYawRadians,
      event.dispersionPitchRadians,
      view.projectileDirection
    );

    view.weaponId = event.weaponId;
    view.sequence = event.sequence;
    view.acceptedAtOffsetSeconds = atSeconds;
    const startedAt = performance.now();
    view.spawned = this.dependencies.ballistics.spawn({
      sourceId: event.weaponId,
      sequence: event.sequence,
      origin: view.origin,
      direction: view.projectileDirection,
      sightDirection: view.sightDirection,
      boreDirection: view.boreDirection,
      maxDistance: event.range,
      maxFlightSeconds: event.maxFlightSeconds,
      damage: event.damage,
      ammunition: event.ammunition,
      captureTrace: frame.captureTrace,
    });
    this.projectileMilliseconds += performance.now() - startedAt;
    handlers.onShot?.(view, event);
  }
}
