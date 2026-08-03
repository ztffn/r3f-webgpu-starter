// Hand-packed binary for the simulation hot path.
//
// §5 of the multiplayer decision record keeps the hot path off a general state
// sync tool, so this is a fixed layout with no field names on the wire: 10 bytes
// per command up, 24 bytes per player down.
//
// One rule matters more than the packing. Look angles are QUANTISED, and the
// client must predict using the same quantised value it transmits — otherwise
// every command reconciles against a server that steered a hair differently.
// `quantiseCommand` exists so a client cannot forget.

import type { MotorState, PlayerCommand, PlayerStance } from "../motor/MotorTypes.ts";

export const PacketType = { Commands: 1, Snapshot: 2, Welcome: 3 } as const;

/** tick u32 + buttons u16 + yaw i16 + pitch i16. Buttons outgrew a byte when
 * aim intent became a movement input; a u8 here truncates it to nothing. */
export const BYTES_PER_COMMAND = 10;
export const BYTES_PER_PLAYER = 24;
const COMMAND_HEADER_BYTES = 3;
const SNAPSHOT_HEADER_BYTES = 10;

/** Angles ride as int16. 2*pi/65536 is 5.5e-3 degrees, far below aim precision. */
const ANGLE_SCALE = 32767 / Math.PI;
/** Velocity ride as int16 over +/-64 m/s, which no character reaches. */
const VELOCITY_SCALE = 32767 / 64;

const STANCES: readonly PlayerStance[] = ["stand", "crouch", "prone"];

function packAngle(radians: number): number {
  return clampInt16(Math.round(wrapPi(radians) * ANGLE_SCALE));
}

function unpackAngle(raw: number): number {
  return raw / ANGLE_SCALE;
}

function wrapPi(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  const wrapped = (radians + Math.PI) % (2 * Math.PI);
  return (wrapped < 0 ? wrapped + 2 * Math.PI : wrapped) - Math.PI;
}

function clampInt16(value: number): number {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : value;
}

/**
 * Rounds a command's angles through the wire representation. A client MUST
 * predict with the result, not with its raw pointer-derived angles.
 */
export function quantiseCommand(command: PlayerCommand): PlayerCommand {
  return {
    tick: command.tick,
    buttons: command.buttons & 0xffff,
    yawRadians: unpackAngle(packAngle(command.yawRadians)),
    pitchRadians: unpackAngle(packAngle(command.pitchRadians)),
  };
}

export function encodeCommands(commands: readonly PlayerCommand[]): Uint8Array {
  const count = Math.min(commands.length, 0xffff);
  const buffer = new ArrayBuffer(COMMAND_HEADER_BYTES + count * BYTES_PER_COMMAND);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Commands);
  view.setUint16(1, count);
  let at = COMMAND_HEADER_BYTES;
  for (let index = commands.length - count; index < commands.length; index += 1) {
    const command = commands[index]!;
    view.setUint32(at, command.tick >>> 0);
    view.setUint16(at + 4, command.buttons & 0xffff);
    view.setInt16(at + 6, packAngle(command.yawRadians));
    view.setInt16(at + 8, packAngle(command.pitchRadians));
    at += BYTES_PER_COMMAND;
  }
  return new Uint8Array(buffer);
}

export function decodeCommands(bytes: Uint8Array): PlayerCommand[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(1);
  const commands: PlayerCommand[] = [];
  let at = COMMAND_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    commands.push({
      tick: view.getUint32(at),
      buttons: view.getUint16(at + 4),
      yawRadians: unpackAngle(view.getInt16(at + 6)),
      pitchRadians: unpackAngle(view.getInt16(at + 8)),
    });
    at += BYTES_PER_COMMAND;
  }
  return commands;
}

export interface SnapshotPlayer {
  readonly id: number;
  readonly state: MotorState;
}

export interface DecodedSnapshot {
  readonly tick: number;
  /** Highest command tick the server had consumed for the receiving client. */
  readonly acknowledgedCommandTick: number;
  readonly players: SnapshotPlayer[];
}

export function encodeSnapshot(
  tick: number,
  acknowledgedCommandTick: number,
  players: readonly SnapshotPlayer[]
): Uint8Array {
  const count = Math.min(players.length, 0xff);
  const buffer = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + count * BYTES_PER_PLAYER);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Snapshot);
  view.setUint32(1, tick >>> 0);
  view.setUint32(5, acknowledgedCommandTick >>> 0);
  view.setUint8(9, count);

  let at = SNAPSHOT_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    const { id, state } = players[index]!;
    view.setUint16(at, id & 0xffff);
    view.setFloat32(at + 2, state.position.x);
    view.setFloat32(at + 6, state.position.y);
    view.setFloat32(at + 10, state.position.z);
    view.setInt16(at + 14, clampInt16(Math.round(state.velocity.x * VELOCITY_SCALE)));
    view.setInt16(at + 16, clampInt16(Math.round(state.velocity.y * VELOCITY_SCALE)));
    view.setInt16(at + 18, clampInt16(Math.round(state.velocity.z * VELOCITY_SCALE)));
    view.setInt16(at + 20, packAngle(state.yawRadians));
    const stanceBits = Math.max(0, STANCES.indexOf(state.stance));
    view.setUint8(
      at + 22,
      stanceBits | (state.grounded ? 1 << 2 : 0) | (state.sprinting ? 1 << 3 : 0)
    );
    view.setUint8(at + 23, state.contactFlags & 0xff);
    at += BYTES_PER_PLAYER;
  }
  return new Uint8Array(buffer);
}

export function decodeSnapshot(bytes: Uint8Array): DecodedSnapshot {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint8(9);
  const players: SnapshotPlayer[] = [];
  let at = SNAPSHOT_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    const flags = view.getUint8(at + 22);
    players.push({
      id: view.getUint16(at),
      state: {
        tick: view.getUint32(1),
        position: {
          x: view.getFloat32(at + 2),
          y: view.getFloat32(at + 6),
          z: view.getFloat32(at + 10),
        },
        velocity: {
          x: view.getInt16(at + 14) / VELOCITY_SCALE,
          y: view.getInt16(at + 16) / VELOCITY_SCALE,
          z: view.getInt16(at + 18) / VELOCITY_SCALE,
        },
        yawRadians: unpackAngle(view.getInt16(at + 20)),
        pitchRadians: 0,
        stance: STANCES[flags & 0b11] ?? "stand",
        previousStance: STANCES[flags & 0b11] ?? "stand",
        stanceProgress: 1,
        grounded: (flags & (1 << 2)) !== 0,
        sprinting: (flags & (1 << 3)) !== 0,
        contactFlags: view.getUint8(at + 23),
      },
    });
    at += BYTES_PER_PLAYER;
  }
  return {
    tick: view.getUint32(1),
    acknowledgedCommandTick: view.getUint32(5),
    players,
  };
}

/**
 * Server's first message: which player the receiving client controls, and
 * WHERE it put them.
 *
 * The spawn position is not optional. Without it the client has to guess its
 * own starting point, and every join begins with a teleport the width of the
 * guess — measured at 6 m against a ring spawn before this field existed.
 */
export function encodeWelcome(
  playerId: number,
  tick: number,
  spawn: { x: number; y: number; z: number }
): Uint8Array {
  const buffer = new ArrayBuffer(19);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Welcome);
  view.setUint16(1, playerId & 0xffff);
  view.setUint32(3, tick >>> 0);
  view.setFloat32(7, spawn.x);
  view.setFloat32(11, spawn.y);
  view.setFloat32(15, spawn.z);
  return new Uint8Array(buffer);
}

export function decodeWelcome(bytes: Uint8Array): {
  playerId: number;
  tick: number;
  spawn: { x: number; y: number; z: number };
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    playerId: view.getUint16(1),
    tick: view.getUint32(3),
    spawn: { x: view.getFloat32(7), y: view.getFloat32(11), z: view.getFloat32(15) },
  };
}

export function packetTypeOf(bytes: Uint8Array): number {
  return bytes.length > 0 ? bytes[0]! : 0;
}
