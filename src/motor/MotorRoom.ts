// A set of character motors sharing one Rapier world and one terrain surface.
//
// This is the unit both sides of the network run: the client holds a room of
// one for prediction, the server holds a room of up to 64 for authority. The
// room exists mainly to own the world step — that must happen exactly once per
// tick after every motor has computed its movement, never once per player.

import type RAPIER from "@dimforge/rapier3d-compat";
import { CharacterMotor } from "./CharacterMotor.ts";
import { StaticTerrainCollider, type TerrainSurface } from "./TerrainCollider.ts";
import {
  DEFAULT_MOTOR_TUNING,
  createPlayerCommand,
  type MotorHeightSource,
  type MotorState,
  type MotorTuning,
  type PlayerCommand,
} from "./MotorTypes.ts";

export interface MotorRoomOptions {
  readonly tuning?: MotorTuning;
  /**
   * Build one shared static surface spanning this many metres instead of
   * giving every motor its own following window. Set it on a server; leave it
   * off for a client room of one, where a following window has no edges.
   */
  readonly sharedSurfaceSpanMetres?: number;
}

export interface RoomSnapshot {
  tick: number;
  readonly players: Array<{ readonly id: string; readonly state: MotorState }>;
}

export class MotorRoom {
  readonly tuning: MotorTuning;
  tick = 0;

  /** Milliseconds the last `step` spent in motors and in the world solve. */
  motorMilliseconds = 0;
  worldMilliseconds = 0;

  private readonly rapier: typeof RAPIER;
  private readonly world: RAPIER.World;
  private readonly heightSource: MotorHeightSource;
  private readonly sharedSurface: TerrainSurface | null;
  private readonly motors = new Map<string, CharacterMotor>();
  private readonly idle: PlayerCommand;

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    heightSource: MotorHeightSource,
    options: MotorRoomOptions = {}
  ) {
    this.rapier = rapier;
    this.world = world;
    this.heightSource = heightSource;
    this.tuning = options.tuning ?? DEFAULT_MOTOR_TUNING;
    this.idle = createPlayerCommand();
    this.sharedSurface =
      options.sharedSurfaceSpanMetres === undefined
        ? null
        : new StaticTerrainCollider(
            rapier,
            world,
            heightSource,
            options.sharedSurfaceSpanMetres
          );
    // The character solver and every query read structures that only exist
    // after a step, so the world is stepped once before any motor runs.
    world.step();
  }

  get size(): number {
    return this.motors.size;
  }

  get playerIds(): IterableIterator<string> {
    return this.motors.keys();
  }

  add(id: string, spawn: { x: number; y?: number; z: number }): CharacterMotor {
    const existing = this.motors.get(id);
    if (existing !== undefined) return existing;
    const motor = new CharacterMotor(this.rapier, this.world, this.heightSource, {
      tuning: this.tuning,
      spawn,
      ...(this.sharedSurface !== null ? { surface: this.sharedSurface } : {}),
    });
    this.motors.set(id, motor);
    return motor;
  }

  remove(id: string): void {
    const motor = this.motors.get(id);
    if (motor === undefined) return;
    motor.dispose();
    this.motors.delete(id);
  }

  get(id: string): CharacterMotor | undefined {
    return this.motors.get(id);
  }

  /**
   * Advances every motor one tick, then the world once. A player with no
   * command this tick steps on an idle command rather than being skipped, so
   * gravity and momentum still apply to a client whose packet was lost.
   */
  step(commands: ReadonlyMap<string, PlayerCommand>): number {
    const startedMotors = performance.now();
    for (const [id, motor] of this.motors) {
      motor.step(commands.get(id) ?? this.idleFor(motor));
    }
    const startedWorld = performance.now();
    this.motorMilliseconds = startedWorld - startedMotors;
    this.world.step();
    this.worldMilliseconds = performance.now() - startedWorld;
    this.tick += 1;
    return this.tick;
  }

  /** Keeps the last look angles so a dropped packet does not snap the aim. */
  private idleFor(motor: CharacterMotor): PlayerCommand {
    const idle = this.idle as { -readonly [K in keyof PlayerCommand]: PlayerCommand[K] };
    idle.tick = this.tick;
    idle.buttons = 0;
    idle.yawRadians = motor.state.yawRadians;
    idle.pitchRadians = motor.state.pitchRadians;
    return idle;
  }

  snapshotInto(target: RoomSnapshot): RoomSnapshot {
    target.tick = this.tick;
    const players = target.players as Array<{ id: string; state: MotorState }>;
    players.length = 0;
    for (const [id, motor] of this.motors) players.push({ id, state: motor.state });
    return target;
  }

  dispose(): void {
    for (const motor of this.motors.values()) motor.dispose();
    this.motors.clear();
    this.sharedSurface?.dispose();
  }
}
