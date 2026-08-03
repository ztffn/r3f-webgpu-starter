// Hand-packed binary for the simulation hot path.
//
// §5 of the multiplayer decision record keeps the hot path off a general state
// sync tool, so this is a fixed layout with no field names on the wire: 10 bytes
// per command up, 27 bytes per player down.
//
// One rule matters more than the packing. Look angles are QUANTISED, and the
// client must predict using the same quantised value it transmits — otherwise
// every command reconciles against a server that steered a hair differently.
// `quantiseCommand` exists so a client cannot forget.

import type { MotorState, PlayerCommand, PlayerStance } from "../motor/MotorTypes.ts";

export const PacketType = {
  Commands: 1,
  Snapshot: 2,
  Welcome: 3,
  WorldState: 4,
  /** Down: the room's visual dial overrides, sparse. */
  VisualDials: 5,
  /** Up: an admin asking for one dial change. Refused unless the server allows it. */
  SetVisualDial: 6,
} as const;

/** tick u32 + buttons u16 + yaw i16 + pitch i16. Buttons outgrew a byte when
 * aim intent became a movement input; a u8 here truncates it to nothing. */
export const BYTES_PER_COMMAND = 10;
/** id u16 + position 3xf32 + velocity 3xi16 + yaw i16 + flags u8 (stance 0-1,
 * grounded 2, sprinting 3, previous stance 4-5, aiming 6) + contact u8 +
 * pitch i16 + stance progress u8. */
export const BYTES_PER_PLAYER = 27;
const COMMAND_HEADER_BYTES = 3;
const SNAPSHOT_HEADER_BYTES = 10;

/** Angles ride as int16. 2*pi/65536 is 5.5e-3 degrees, far below aim precision. */
const ANGLE_SCALE = 32767 / Math.PI;
/** Velocity ride as int16 over +/-64 m/s, which no character reaches. */
const VELOCITY_SCALE = 32767 / 64;

const STANCES: readonly PlayerStance[] = ["stand", "crouch", "prone"];
const STANCE_BITS: Record<PlayerStance, number> = { stand: 0, crouch: 1, prone: 2 };

function packAngle(radians: number): number {
  return clampInt16(Math.round(wrapPi(radians) * ANGLE_SCALE));
}

function unpackAngle(raw: number): number {
  return raw / ANGLE_SCALE;
}

/** Wrap into (-pi, pi]. Exported as the one angle-wrap shared with consumers. */
export function wrapPi(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  const wrapped = (radians + Math.PI) % (2 * Math.PI);
  return (wrapped < 0 ? wrapped + 2 * Math.PI : wrapped) - Math.PI;
}

function clampInt16(value: number): number {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : value;
}

/** Stance progress rides as u8; 1/255 is far below anything visible in a blend. */
function packProgress(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 255);
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

/**
 * Decodes a command batch from an UNTRUSTED peer.
 *
 * The declared count is a claim, not a fact. Believing it and reading past the
 * buffer throws a RangeError out of the socket handler, which on a server is an
 * uncaught exception and a dead room — three bytes from any client. The count is
 * therefore clamped to what actually arrived, and a short header yields nothing.
 */
export function decodeCommands(bytes: Uint8Array): PlayerCommand[] {
  if (bytes.byteLength < COMMAND_HEADER_BYTES) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const available = Math.floor((bytes.byteLength - COMMAND_HEADER_BYTES) / BYTES_PER_COMMAND);
  const count = Math.min(view.getUint16(1), available);
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
    const stanceBits = STANCE_BITS[state.stance];
    const previousStanceBits = STANCE_BITS[state.previousStance];
    view.setUint8(
      at + 22,
      stanceBits |
        (state.grounded ? 1 << 2 : 0) |
        (state.sprinting ? 1 << 3 : 0) |
        (previousStanceBits << 4) |
        (state.aiming ? 1 << 6 : 0)
    );
    view.setUint8(at + 23, state.contactFlags & 0xff);
    view.setInt16(at + 24, packAngle(state.pitchRadians));
    view.setUint8(at + 26, packProgress(state.stanceProgress));
    at += BYTES_PER_PLAYER;
  }
  return new Uint8Array(buffer);
}

/** Same untrusted-input rule as `decodeCommands`; a hostile server is a peer too. */
export function decodeSnapshot(bytes: Uint8Array): DecodedSnapshot {
  if (bytes.byteLength < SNAPSHOT_HEADER_BYTES) {
    return { tick: 0, acknowledgedCommandTick: 0, players: [] };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const available = Math.floor((bytes.byteLength - SNAPSHOT_HEADER_BYTES) / BYTES_PER_PLAYER);
  const count = Math.min(view.getUint8(9), available);
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
        pitchRadians: unpackAngle(view.getInt16(at + 24)),
        stance: STANCES[flags & 0b11] ?? "stand",
        previousStance: STANCES[(flags >> 4) & 0b11] ?? "stand",
        stanceProgress: view.getUint8(at + 26) / 255,
        grounded: (flags & (1 << 2)) !== 0,
        sprinting: (flags & (1 << 3)) !== 0,
        aiming: (flags & (1 << 6)) !== 0,
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
const WELCOME_BYTES = 19;

export function encodeWelcome(
  playerId: number,
  tick: number,
  spawn: { x: number; y: number; z: number }
): Uint8Array {
  const buffer = new ArrayBuffer(WELCOME_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Welcome);
  view.setUint16(1, playerId & 0xffff);
  view.setUint32(3, tick >>> 0);
  view.setFloat32(7, spawn.x);
  view.setFloat32(11, spawn.y);
  view.setFloat32(15, spawn.z);
  return new Uint8Array(buffer);
}

/** Null when the packet is too short to be a welcome; callers must ignore it. */
export function decodeWelcome(bytes: Uint8Array): {
  playerId: number;
  tick: number;
  spawn: { x: number; y: number; z: number };
} | null {
  if (bytes.byteLength < WELCOME_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    playerId: view.getUint16(1),
    tick: view.getUint32(3),
    spawn: { x: view.getFloat32(7), y: view.getFloat32(11), z: view.getFloat32(15) },
  };
}

/**
 * Room-scope state that is not per-player and not per-tick: today, the weather.
 *
 * Sent once on connection and again only when it changes. It is NOT folded into
 * the snapshot on purpose — this changes a handful of times a match, and carrying
 * it at the patch rate would be 20 packets a second per player spent saying
 * nothing happened.
 *
 * It rides the codec rather than the room framework's own state sync because
 * `GameServer` is the authority. Weather is not cosmetic here: fog IS concealment,
 * so a visibility check consulting it has to reach this from the transport-agnostic
 * layer, and the Node loopback suite has to be able to see it.
 *
 * One byte of payload today. Time of day and a wind seed are the likeliest fields
 * to join it, and this is the packet that grows for them.
 */
const WORLD_STATE_BYTES = 3;
/** Bit 0 of the flags byte: this room accepts dial changes from its clients. */
const WORLD_FLAG_CLIENT_DIALS = 1 << 0;

export interface WorldState {
  /** Index into `WEATHER_PRESET_IDS`; the presentation side resolves the meaning. */
  readonly weatherIndex: number;
  /**
   * The room will accept dial changes from this client.
   *
   * Told rather than discovered, because the alternative is a panel that cannot
   * tell "refused" from "not applied yet" — refusals are silent by design, so
   * without this bit an ordinary player would see live-looking sliders that do
   * nothing. Room-wide rather than per-player: it reflects a server flag.
   */
  readonly clientDialsAllowed: boolean;
}

export function encodeWorldState(state: WorldState): Uint8Array {
  const bytes = new Uint8Array(WORLD_STATE_BYTES);
  bytes[0] = PacketType.WorldState;
  bytes[1] = state.weatherIndex & 0xff;
  bytes[2] = state.clientDialsAllowed ? WORLD_FLAG_CLIENT_DIALS : 0;
  return bytes;
}

/**
 * Null when the packet is too short, same rule as `decodeWelcome` — a hostile
 * server is a peer too, and every decoder here is hardened against a short buffer.
 *
 * The index is reported RAW rather than clamped to a preset this build knows: a
 * newer server can legitimately name one that shipped after this client, and
 * substituting something here would hide that. `weatherPresetAt` falls back.
 */
export function decodeWorldState(bytes: Uint8Array): WorldState | null {
  if (bytes.byteLength < WORLD_STATE_BYTES) return null;
  return {
    weatherIndex: bytes[1]!,
    clientDialsAllowed: (bytes[2]! & WORLD_FLAG_CLIENT_DIALS) !== 0,
  };
}

/**
 * Visual dial overrides, SPARSE: only the dials an admin has actually moved.
 *
 * Sparse rather than a fixed 25-slot struct because the common case is a room
 * nobody has touched, which costs two bytes instead of a hundred and fifty. The
 * full set goes out on join; a change goes out carrying only what changed.
 *
 * `type u8 + complete u8 + count u8 + (dial id u8 + value f32) * count`. The value
 * is a full float rather than a quantised one because every dial has its own range
 * — ground fog density lives in thousandths while fog far runs to 4000, and one
 * shared scale cannot serve both.
 *
 * `complete` is load-bearing and was not obvious. A delta cannot express a dial
 * being CLEARED: an id absent from the payload means "unchanged", so a reset sent
 * as a delta leaves every client still applying an override the room no longer
 * holds. A complete set says "replace yours with this", which makes a reset an
 * empty complete set and needs no sentinel value.
 */
const DIAL_HEADER_BYTES = 3;
const BYTES_PER_DIAL = 5;

export interface DecodedVisualDials {
  /** Replace the local set with this. False means merge it as a delta. */
  readonly complete: boolean;
  readonly overrides: Map<number, number>;
}

export function encodeVisualDials(
  overrides: ReadonlyMap<number, number>,
  complete: boolean
): Uint8Array {
  const entries = [...overrides].slice(0, 0xff);
  const buffer = new ArrayBuffer(DIAL_HEADER_BYTES + entries.length * BYTES_PER_DIAL);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.VisualDials);
  view.setUint8(1, complete ? 1 : 0);
  view.setUint8(2, entries.length);
  let at = DIAL_HEADER_BYTES;
  for (const [id, value] of entries) {
    view.setUint8(at, id & 0xff);
    view.setFloat32(at + 1, value);
    at += BYTES_PER_DIAL;
  }
  return new Uint8Array(buffer);
}

/**
 * Same untrusted-input rule as the rest: the declared count is a claim, clamped to
 * what actually arrived, and a short header yields an empty set rather than throwing.
 *
 * Non-finite values are DROPPED HERE rather than reported. Everywhere else in this
 * file a hostile value travels as it arrived and is judged upstream, but a NaN
 * headed for a uniform does not throw — it silently blanks whatever term it feeds,
 * and the symptom surfaces somewhere unrelated. This is the cheapest place to stop it.
 */
export function decodeVisualDials(bytes: Uint8Array): DecodedVisualDials {
  const overrides = new Map<number, number>();
  if (bytes.byteLength < DIAL_HEADER_BYTES) return { complete: false, overrides };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const available = Math.floor((bytes.byteLength - DIAL_HEADER_BYTES) / BYTES_PER_DIAL);
  const count = Math.min(view.getUint8(2), available);
  let at = DIAL_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    const value = view.getFloat32(at + 1);
    if (Number.isFinite(value)) overrides.set(view.getUint8(at), value);
    at += BYTES_PER_DIAL;
  }
  return { complete: view.getUint8(1) !== 0, overrides };
}

/** Upstream: one dial, one value. A drag becomes a stream of these. */
const SET_DIAL_BYTES = 6;

export function encodeSetVisualDial(id: number, value: number): Uint8Array {
  const buffer = new ArrayBuffer(SET_DIAL_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.SetVisualDial);
  view.setUint8(1, id & 0xff);
  view.setFloat32(2, value);
  return new Uint8Array(buffer);
}

/**
 * Null on a short buffer or a non-finite value — this one arrives from a CLIENT,
 * so it is the hostile direction and the server must be able to ignore it without
 * a branch of its own.
 */
export function decodeSetVisualDial(bytes: Uint8Array): { id: number; value: number } | null {
  if (bytes.byteLength < SET_DIAL_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getFloat32(2);
  if (!Number.isFinite(value)) return null;
  return { id: view.getUint8(1), value };
}

export function packetTypeOf(bytes: Uint8Array): number {
  return bytes.length > 0 ? bytes[0]! : 0;
}
