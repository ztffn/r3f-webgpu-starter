// The shared headless character motor.
//
// One implementation runs in the browser for prediction and in Node for
// authority (docs/plans/2026-08-02-... §3). It consumes a sequenced
// PlayerCommand and produces a MotorState; it reads no DOM, no camera, no bone,
// and imports no Three.js at runtime, so a server can construct and step it
// with no renderer and no browser globals present.

import type RAPIER from "@dimforge/rapier3d-compat";
import {
  TerrainCollider,
  type TerrainColliderOptions,
  type TerrainSurface,
} from "./TerrainCollider.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorContact,
  MotorInput,
  createMotorState,
  eyeHeightFor,
  type MotorHeightSource,
  type MotorState,
  type MotorTuning,
  type PlayerCommand,
  type PlayerStance,
  type Vec3 as Vec3Like,
} from "./MotorTypes.ts";

const HALF_PI = Math.PI / 2;
const PITCH_LIMIT = HALF_PI - 0.01;
/** Downward bias kept on the vertical axis while grounded to hold contact. */
const GROUND_STICK_SPEED = 2;

export interface CharacterMotorOptions {
  readonly tuning?: MotorTuning;
  readonly terrain?: TerrainColliderOptions;
  /**
   * A surface shared with other motors. Supply this on a server so one room
   * holds one terrain collider. Ownership stays with the caller: the motor will
   * not dispose a surface it did not create.
   */
  readonly surface?: TerrainSurface;
  /** Feet position at spawn. Y is resolved onto the terrain if omitted. */
  readonly spawn?: { x: number; y?: number; z: number };
}

/**
 * Fixed-tick character motor over a Rapier kinematic body.
 *
 * `step` advances exactly one tick of `tuning.fixedTimestepSeconds` regardless
 * of wall-clock time, so a server replaying a recorded command stream
 * reproduces the client's path to within float divergence — the tolerance the
 * design assumes, not bitwise equality (§2 of the decision record).
 *
 * It deliberately does NOT step the Rapier world. A motor does not own the
 * world: a room holds many motors and must step once per tick, not once per
 * player. Use `MotorRoom` unless you are driving the world yourself.
 */
export class CharacterMotor {
  readonly state: MotorState = createMotorState();
  readonly tuning: MotorTuning;
  readonly terrain: TerrainSurface;
  private readonly ownsTerrain: boolean;

  private readonly rapier: typeof RAPIER;
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;

  /** Scratch, reused every tick so the motor itself allocates nothing. */
  private readonly desired = { x: 0, y: 0, z: 0 };
  private readonly nextTranslation = { x: 0, y: 0, z: 0 };
  private readonly probeRotation = { x: 0, y: 0, z: 0, w: 1 };
  private readonly probeCentre = { x: 0, y: 0, z: 0 };

  private stanceBlendRemaining = 0;

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    heightSource: MotorHeightSource,
    options: CharacterMotorOptions = {}
  ) {
    this.rapier = rapier;
    this.world = world;
    this.tuning = options.tuning ?? DEFAULT_MOTOR_TUNING;

    const spawnX = options.spawn?.x ?? 0;
    const spawnZ = options.spawn?.z ?? 0;
    this.ownsTerrain = options.surface === undefined;
    this.terrain =
      options.surface ?? new TerrainCollider(rapier, world, heightSource, options.terrain);
    this.terrain.update(spawnX, spawnZ);
    const spawnY = options.spawn?.y ?? heightSource.sample(spawnX, spawnZ);

    const dimensions = this.tuning.stances.stand;
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawnX,
        spawnY + dimensions.height / 2,
        spawnZ
      )
    );
    this.collider = world.createCollider(
      rapier.ColliderDesc.capsule(
        capsuleHalfHeight(dimensions.height, dimensions.radius),
        dimensions.radius
      ),
      this.body
    );

    this.controller = world.createCharacterController(this.tuning.contactOffsetMetres);
    this.controller.enableAutostep(this.tuning.maxStepHeightMetres, this.tuning.contactOffsetMetres, true);
    this.controller.enableSnapToGround(this.tuning.snapToGroundMetres);
    this.controller.setMaxSlopeClimbAngle(this.tuning.maxSlopeClimbRadians);
    this.controller.setMinSlopeSlideAngle(this.tuning.minSlopeSlideRadians);
    this.controller.setApplyImpulsesToDynamicBodies(true);

    this.state.position.x = spawnX;
    this.state.position.y = spawnY;
    this.state.position.z = spawnZ;
  }

  /** Eye position for presentation. Never part of authoritative state. */
  eyePosition(out: { x: number; y: number; z: number }): void {
    out.x = this.state.position.x;
    out.y = this.state.position.y + eyeHeightFor(this.state, this.tuning);
    out.z = this.state.position.z;
  }

  /**
   * Forces the motor onto an authoritative pose. This is the reconciliation
   * entry point: a client rewinds to the server's state here and then replays
   * its unacknowledged commands. `setTranslation` rather than
   * `setNextKinematicTranslation`, because a correction must take effect before
   * the replay steps rather than being interpolated into over the next tick.
   */
  teleport(position: Vec3Like, velocity?: Vec3Like): void {
    const feetY = position.y;
    this.state.position.x = position.x;
    this.state.position.y = feetY;
    this.state.position.z = position.z;
    if (velocity !== undefined) {
      this.state.velocity.x = velocity.x;
      this.state.velocity.y = velocity.y;
      this.state.velocity.z = velocity.z;
    }
    this.nextTranslation.x = position.x;
    this.nextTranslation.y = feetY + this.currentHalfHeightOffset();
    this.nextTranslation.z = position.z;
    this.body.setTranslation(this.nextTranslation, true);
    this.body.setNextKinematicTranslation(this.nextTranslation);
    this.terrain.update(position.x, position.z);
  }

  dispose(): void {
    this.world.removeCharacterController(this.controller);
    this.world.removeRigidBody(this.body);
    if (this.ownsTerrain) this.terrain.dispose();
  }

  step(command: PlayerCommand): MotorState {
    const dt = this.tuning.fixedTimestepSeconds;
    const state = this.state;
    let contacts = 0;

    state.yawRadians = command.yawRadians;
    state.pitchRadians = clamp(command.pitchRadians, -PITCH_LIMIT, PITCH_LIMIT);

    contacts |= this.resolveStance(command.buttons, dt);

    const dimensions = this.tuning.stances[state.stance];
    contacts |= this.integrateVelocity(command.buttons, dimensions.speed, dt);

    this.desired.x = state.velocity.x * dt;
    this.desired.y = state.velocity.y * dt;
    this.desired.z = state.velocity.z * dt;

    this.controller.computeColliderMovement(this.collider, this.desired);
    const moved = this.controller.computedMovement();
    const at = this.body.translation();
    this.nextTranslation.x = at.x + moved.x;
    this.nextTranslation.y = at.y + moved.y;
    this.nextTranslation.z = at.z + moved.z;
    this.body.setNextKinematicTranslation(this.nextTranslation);

    const grounded = this.controller.computedGrounded();
    state.grounded = grounded;
    if (grounded) contacts |= MotorContact.Grounded;
    if (this.isOnSteepGround()) contacts |= MotorContact.SteepSlope;

    // Recovering horizontal velocity from the solved movement is what makes a
    // wall actually stop the player: the requested velocity is unchanged, but
    // the achieved one is not, and prediction must carry the achieved one.
    state.velocity.x = moved.x / dt;
    state.velocity.z = moved.z / dt;
    if (blocked(this.desired.x, moved.x) || blocked(this.desired.z, moved.z)) {
      contacts |= MotorContact.WallContact;
    }
    if (grounded) {
      state.velocity.y = 0;
    } else {
      state.velocity.y = moved.y / dt;
    }

    state.position.x = this.nextTranslation.x;
    state.position.y = this.nextTranslation.y - this.currentHalfHeightOffset();
    state.position.z = this.nextTranslation.z;

    this.terrain.update(state.position.x, state.position.z);

    state.tick = command.tick;
    state.contactFlags = contacts;
    return state;
  }

  private currentHalfHeightOffset(): number {
    return this.tuning.stances[this.state.stance].height / 2;
  }

  /**
   * Applies the requested stance, refusing a stand-up that has no headroom.
   * The collider snaps to the new shape immediately; only `stanceProgress`
   * blends, and that value is presentation.
   */
  private resolveStance(buttons: number, dt: number): number {
    const state = this.state;
    if (this.stanceBlendRemaining > 0) {
      this.stanceBlendRemaining = Math.max(0, this.stanceBlendRemaining - dt);
      state.stanceProgress =
        this.tuning.stanceBlendSeconds > 0
          ? 1 - this.stanceBlendRemaining / this.tuning.stanceBlendSeconds
          : 1;
    }

    const wanted: PlayerStance =
      (buttons & MotorInput.Prone) !== 0
        ? "prone"
        : (buttons & MotorInput.Crouch) !== 0
          ? "crouch"
          : "stand";
    if (wanted === state.stance) return 0;

    const next = this.tuning.stances[wanted];
    const current = this.tuning.stances[state.stance];
    if (next.height > current.height && !this.hasClearanceFor(wanted)) {
      return MotorContact.CeilingBlocked;
    }

    // Feet are the anchor across a stance change, so the capsule centre moves
    // and the body translation has to be rewritten to match.
    const feetY = this.state.position.y;
    state.previousStance = state.stance;
    state.stance = wanted;
    this.stanceBlendRemaining = this.tuning.stanceBlendSeconds;
    state.stanceProgress = 0;
    this.collider.setShape(
      new this.rapier.Capsule(capsuleHalfHeight(next.height, next.radius), next.radius)
    );
    const at = this.body.translation();
    this.nextTranslation.x = at.x;
    this.nextTranslation.y = feetY + next.height / 2;
    this.nextTranslation.z = at.z;
    this.body.setTranslation(this.nextTranslation, true);
    return 0;
  }

  /**
   * Is there room to grow into `stance`? The probe capsule is shrunk and lifted
   * by the contact offset so that resting contact with the ground under the
   * feet does not read as a blocked ceiling.
   */
  private hasClearanceFor(stance: PlayerStance): boolean {
    const dimensions = this.tuning.stances[stance];
    const skin = this.tuning.contactOffsetMetres;
    const radius = Math.max(0.01, dimensions.radius - skin * 2);
    const halfHeight = capsuleHalfHeight(dimensions.height, dimensions.radius);
    this.probeCentre.x = this.state.position.x;
    this.probeCentre.y = this.state.position.y + dimensions.height / 2 + skin * 2;
    this.probeCentre.z = this.state.position.z;
    const hit = this.world.intersectionWithShape(
      this.probeCentre,
      this.probeRotation,
      new this.rapier.Capsule(halfHeight, radius),
      undefined,
      undefined,
      this.collider
    );
    return hit === null;
  }

  private isOnSteepGround(): boolean {
    const limit = Math.cos(this.tuning.maxSlopeClimbRadians);
    const count = this.controller.numComputedCollisions();
    for (let index = 0; index < count; index += 1) {
      const collision = this.controller.computedCollision(index);
      const normal = collision?.normal2;
      if (normal === undefined || normal.y <= 0) continue;
      if (normal.y < limit) return true;
    }
    return false;
  }

  private integrateVelocity(buttons: number, maxSpeed: number, dt: number): number {
    const state = this.state;
    const sin = Math.sin(state.yawRadians);
    const cos = Math.cos(state.yawRadians);

    let forward = 0;
    let strafe = 0;
    if ((buttons & MotorInput.Forward) !== 0) forward += 1;
    if ((buttons & MotorInput.Back) !== 0) forward -= 1;
    if ((buttons & MotorInput.Left) !== 0) strafe -= 1;
    if ((buttons & MotorInput.Right) !== 0) strafe += 1;

    // Yaw 0 faces -Z and +yaw rotates about +Y, matching the camera rig and
    // Three.js. That makes forward (-sin, -cos) and right (cos, -sin); getting
    // the X sign wrong here silently mirrors every strafe and turn.
    let wantX = -forward * sin + strafe * cos;
    let wantZ = -forward * cos - strafe * sin;
    const magnitude = Math.hypot(wantX, wantZ);
    const sprinting =
      (buttons & MotorInput.Sprint) !== 0 && state.stance === "stand" && forward > 0;
    const speed = maxSpeed * (sprinting ? this.tuning.sprintMultiplier : 1);
    if (magnitude > 0) {
      wantX = (wantX / magnitude) * speed;
      wantZ = (wantZ / magnitude) * speed;
    }

    const control = state.grounded ? 1 : this.tuning.airControl;
    const rate = (magnitude > 0 ? this.tuning.acceleration : this.tuning.deceleration) * control * dt;
    state.velocity.x = approach(state.velocity.x, wantX, rate);
    state.velocity.z = approach(state.velocity.z, wantZ, rate);

    if (state.grounded) {
      const jumping = (buttons & MotorInput.Jump) !== 0 && state.stance === "stand";
      state.velocity.y = jumping ? this.tuning.jumpSpeedMetresPerSecond : -GROUND_STICK_SPEED;
    } else {
      state.velocity.y -= this.tuning.gravityMetresPerSecondSquared * dt;
    }
    return 0;
  }
}

function capsuleHalfHeight(height: number, radius: number): number {
  return Math.max(0.01, (height - radius * 2) / 2);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function approach(current: number, target: number, maxDelta: number): number {
  const difference = target - current;
  if (Math.abs(difference) <= maxDelta) return target;
  return current + Math.sign(difference) * maxDelta;
}

function blocked(requested: number, achieved: number): boolean {
  return Math.abs(requested) > 1e-4 && Math.abs(achieved) < Math.abs(requested) * 0.5;
}
