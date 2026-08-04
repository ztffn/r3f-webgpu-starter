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
import { clamp } from "../combat/math.ts";

export const PacketType = {
  Commands: 1,
  Snapshot: 2,
  Welcome: 3,
  /** Down: everything about the room that is not per-player. */
  RoomState: 4,
  /** Up: an admin asking for one dial change. Refused unless the server allows it. */
  SetVisualDial: 5,
  /** Up: the client claiming it fired. Carries intent, never a result. */
  Fire: 6,
  /** Up: the client changed weapons. The server holds the loadout truth. */
  SelectWeapon: 7,
  /** Up: the client started a reload. Rounds move when the server's timer says. */
  Reload: 8,
  /** Down: someone else's accepted shot, for tracer/flash/report presentation. */
  ShotFired: 9,
  /** Down: every server-owned world target — position, size, health. */
  WorldTargets: 10,
} as const;

/** tick u32 + buttons u16 + yaw i16 + pitch i16. Buttons outgrew a byte when
 * aim intent became a movement input; a u8 here truncates it to nothing. */
export const BYTES_PER_COMMAND = 10;
/** id u16 + position 3xf32 + velocity 3xi16 + yaw i16 + flags u8 (stance 0-1,
 * grounded 2, sprinting 3, previous stance 4-5, aiming 6) + contact u8 +
 * pitch i16 + stance progress u8 + health u8.
 *
 * HEALTH IS NOT MotorState. The motor simulates movement and knows nothing about
 * damage, so health rides beside its state rather than inside it — that is what
 * keeps a shot out of the replay path, since a client replaying unacknowledged
 * commands must not re-derive how much health it had. Dead is `health === 0`
 * rather than its own flag bit, because two encodings of one fact drift. */
export const BYTES_PER_PLAYER = 28;
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
  /** Server-owned hit points, 0-255. 0 is dead. */
  readonly health: number;
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
    view.setUint8(at + 27, Math.max(0, Math.min(255, Math.round(players[index]!.health))));
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
      health: view.getUint8(at + 27),
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
 * ROOM-SCOPE STATE: everything the server owns that is neither per-player nor
 * per-tick. Today that is the weather preset and a sparse set of visual dial
 * overrides layered on top of it.
 *
 * ONE PACKET, not one per kind of setting, and that was the second attempt. Weather
 * and dials shipped as two packet families first, and the split leaked immediately:
 * the bit that gates DIALS had to travel in the WEATHER packet, a join sent two
 * packets to describe one room, the client needed two single-consumer callbacks that
 * published the same object, and the server ran two broadcast disciplines for one
 * class of state. They are one concept — state the server owns, sent on join and on
 * change — so they are one packet.
 *
 * Sent on connection and on change only. There is no periodic rebroadcast, so a
 * client that loses this keeps the old room until it reconnects; that is the right
 * trade for something that changes a handful of times a match, against paying for it
 * every patch to say nothing happened.
 *
 * It rides the codec rather than the room framework's own state sync because
 * `GameServer` is the authority. Weather is not cosmetic here: fog IS concealment,
 * so a visibility check consulting it has to reach this from the transport-agnostic
 * layer, and the Node loopback suite has to be able to see it.
 *
 * `type u8 + flags u8 + weather u8 + dial count u8 + (dial id u8 + value f32) * n`.
 *
 * ALWAYS THE COMPLETE DIAL SET, never a delta, and that is a deliberate trade for
 * simplicity over bytes. A delta cannot express a dial being CLEARED — an absent id
 * means "unchanged" — so supporting one costs a complete-versus-delta flag on the
 * wire, a merge-or-replace branch on the client, and a dirty set beside the values
 * on the server. Sending everything costs 5 bytes per dial anyone has touched: 128
 * bytes if all 25 are in play, at the patch rate, only while an admin is dragging.
 * Against the ~35 KB/s a single client already spends on snapshots, the delta was
 * buying nothing and charging three pieces of state that had to agree.
 *
 * Time of day and a wind seed are the likeliest fields to join it. Damage and
 * world-object state are NOT — they need per-player attribution and entity lifetimes
 * that a sparse id-to-float map cannot carry, so they want their own shape.
 */
const ROOM_STATE_HEADER_BYTES = 4;
const BYTES_PER_DIAL = 5;
/** Bit 0 of the flags byte: this room accepts dial changes from its clients. */
const ROOM_FLAG_CLIENT_DIALS = 1 << 0;

export interface RoomState {
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
  /**
   * Sparse dial overrides on the room's preset, by id. An untouched room holds
   * none, which is the ordinary case.
   *
   * Replaced wholesale on every packet rather than mutated, so it is safe to hand
   * straight to a React consumer as a snapshot — no defensive copy, and no chance
   * of a holder comparing a map against its own mutated self.
   */
  readonly dials: ReadonlyMap<number, number>;
}

export function encodeRoomState(state: RoomState): Uint8Array {
  const count = Math.min(state.dials.size, 0xff);
  const buffer = new ArrayBuffer(ROOM_STATE_HEADER_BYTES + count * BYTES_PER_DIAL);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.RoomState);
  view.setUint8(1, state.clientDialsAllowed ? ROOM_FLAG_CLIENT_DIALS : 0);
  view.setUint8(2, state.weatherIndex & 0xff);
  view.setUint8(3, count);
  let at = ROOM_STATE_HEADER_BYTES;
  let written = 0;
  for (const [id, value] of state.dials) {
    if (written === count) break;
    view.setUint8(at, id & 0xff);
    view.setFloat32(at + 1, value);
    at += BYTES_PER_DIAL;
    written += 1;
  }
  return new Uint8Array(buffer);
}

/**
 * Null on a short header; otherwise the same untrusted-input rule as the rest of
 * this file — the declared dial count is a claim, clamped to what actually arrived.
 *
 * Non-finite dial values are DROPPED HERE rather than reported. Everywhere else a
 * hostile value travels as it arrived and is judged upstream, but a NaN headed for
 * a uniform does not throw — it silently blanks whatever term it feeds, and the
 * symptom surfaces somewhere unrelated. This is the cheapest place to stop it.
 *
 * The weather index, by contrast, IS reported raw: a newer server can legitimately
 * name a preset that shipped after this client, and `weatherPresetAt` falls back to
 * neutral daylight rather than the codec inventing a substitute.
 */
export function decodeRoomState(bytes: Uint8Array): RoomState | null {
  if (bytes.byteLength < ROOM_STATE_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const available = Math.floor(
    (bytes.byteLength - ROOM_STATE_HEADER_BYTES) / BYTES_PER_DIAL
  );
  const count = Math.min(view.getUint8(3), available);
  const dials = new Map<number, number>();
  let at = ROOM_STATE_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    const value = view.getFloat32(at + 1);
    if (Number.isFinite(value)) dials.set(view.getUint8(at), value);
    at += BYTES_PER_DIAL;
  }
  return {
    weatherIndex: view.getUint8(2),
    clientDialsAllowed: (view.getUint8(1) & ROOM_FLAG_CLIENT_DIALS) !== 0,
    dials,
  };
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

/**
 * The client claiming it fired: `type u8 + tick u32 + sequence u16 + yaw i16 +
 * pitch i16 + viewTick u32`.
 *
 * NO ORIGIN, and that is the point. The server takes the shooter's eye from its own
 * authoritative motor state, so an origin cannot be spoofed at all — there is
 * nowhere to put one. The look angles ARE sent, because the shot leaves along the
 * weapon's aimed direction after sway and recoil, which the server does not
 * simulate; it clamps them against the look angles it already has for that tick
 * (see `GameServer.receiveFire`), which bounds the lie without needing full
 * server-side weapon simulation.
 *
 * NO WEAPON either: the server already holds each peer's equipped weapon
 * (`SelectWeapon`), so a claim cannot name a bigger gun than the one in hand.
 *
 * `viewTick` is the server tick of the snapshot the shooter was LOOKING AT when
 * the trigger broke — the lag-compensation rewind target. It is a claim like the
 * direction, so the server clamps how far back it will honor it; lying forward
 * gains nothing and lying backward is bounded to the rewind window.
 *
 * The sequence is the shooter's own shot counter, echoed back on the resulting hit
 * so a client can match an authoritative outcome to the round it fired.
 */
const FIRE_BYTES = 15;

export interface FireClaim {
  readonly tick: number;
  readonly sequence: number;
  readonly yawRadians: number;
  readonly pitchRadians: number;
  /** Server tick of the snapshot the shooter was rendering. */
  readonly viewTick: number;
}

export function encodeFire(claim: FireClaim): Uint8Array {
  const buffer = new ArrayBuffer(FIRE_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Fire);
  view.setUint32(1, claim.tick >>> 0);
  view.setUint16(5, claim.sequence & 0xffff);
  view.setInt16(7, packAngle(claim.yawRadians));
  view.setInt16(9, packAngle(claim.pitchRadians));
  view.setUint32(11, claim.viewTick >>> 0);
  return new Uint8Array(buffer);
}

/** Null on a short buffer — this arrives from a client, so it is hostile input. */
export function decodeFire(bytes: Uint8Array): FireClaim | null {
  if (bytes.byteLength < FIRE_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    tick: view.getUint32(1),
    sequence: view.getUint16(5),
    yawRadians: unpackAngle(view.getInt16(7)),
    pitchRadians: unpackAngle(view.getInt16(9)),
    viewTick: view.getUint32(11),
  };
}

/**
 * A weapon selection or reload claim: intent with a sequence, like fire. One
 * shared sequence counter covers both — they are ordered on one reliable stream,
 * and the dedupe only needs "have I consumed this claim already".
 */
const SELECT_WEAPON_BYTES = 4;
const RELOAD_BYTES = 3;

export interface WeaponClaim {
  readonly sequence: number;
  /** Index into the canonical WEAPON_DEFINITIONS wire order. */
  readonly weaponIndex: number;
}

export function encodeSelectWeapon(claim: WeaponClaim): Uint8Array {
  const buffer = new ArrayBuffer(SELECT_WEAPON_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.SelectWeapon);
  view.setUint16(1, claim.sequence & 0xffff);
  view.setUint8(3, claim.weaponIndex & 0xff);
  return new Uint8Array(buffer);
}

export function decodeSelectWeapon(bytes: Uint8Array): WeaponClaim | null {
  if (bytes.byteLength < SELECT_WEAPON_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { sequence: view.getUint16(1), weaponIndex: view.getUint8(3) };
}

export function encodeReload(sequence: number): Uint8Array {
  const buffer = new ArrayBuffer(RELOAD_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Reload);
  view.setUint16(1, sequence & 0xffff);
  return new Uint8Array(buffer);
}

export function decodeReload(bytes: Uint8Array): { sequence: number } | null {
  if (bytes.byteLength < RELOAD_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { sequence: view.getUint16(1) };
}

/**
 * Someone else's accepted shot, going DOWN: `type u8 + shooter u16 + weapon u8 +
 * sequence u16 + origin 3xf32 + yaw i16 + pitch i16`.
 *
 * PRESENTATION ONLY — tracer, muzzle flash, report, impact dust. The origin and
 * direction are the SERVER'S resolved values (its eye, its clamped aim), so the
 * theatre a bystander sees is the shot the authority actually fired, not the
 * claim. A client must never apply damage from this; damage arrives as health
 * in the snapshot, or not at all. The shooter is excluded from the broadcast —
 * their own client already played the shot locally.
 */
const SHOT_FIRED_BYTES = 22;

export interface ShotFiredEvent {
  readonly shooterId: number;
  readonly weaponIndex: number;
  readonly sequence: number;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly yawRadians: number;
  readonly pitchRadians: number;
}

export function encodeShotFired(event: ShotFiredEvent): Uint8Array {
  const buffer = new ArrayBuffer(SHOT_FIRED_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.ShotFired);
  view.setUint16(1, event.shooterId & 0xffff);
  view.setUint8(3, event.weaponIndex & 0xff);
  view.setUint16(4, event.sequence & 0xffff);
  view.setFloat32(6, event.origin.x);
  view.setFloat32(10, event.origin.y);
  view.setFloat32(14, event.origin.z);
  view.setInt16(18, packAngle(event.yawRadians));
  view.setInt16(20, packAngle(event.pitchRadians));
  return new Uint8Array(buffer);
}

/** Null on a short buffer; a hostile server is a peer too. */
export function decodeShotFired(bytes: Uint8Array): ShotFiredEvent | null {
  if (bytes.byteLength < SHOT_FIRED_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const origin = {
    x: view.getFloat32(6),
    y: view.getFloat32(10),
    z: view.getFloat32(14),
  };
  if (![origin.x, origin.y, origin.z].every(Number.isFinite)) return null;
  return {
    shooterId: view.getUint16(1),
    weaponIndex: view.getUint8(3),
    sequence: view.getUint16(4),
    origin,
    yawRadians: unpackAngle(view.getInt16(18)),
    pitchRadians: unpackAngle(view.getInt16(20)),
  };
}

/**
 * Every server-owned world target, going DOWN, always complete — the same
 * "no deltas" rule as RoomState, and for the same reason: an absent id in a
 * delta cannot be told from an unchanged one. `type u8 + count u8 + per target:
 * id u16 + x f32 + y f32 + z f32 + radius u8 (cm) + height u8 (2 cm units) +
 * health u8 + maxHealth u8`. Y is the FEET, like players.
 */
const WORLD_TARGETS_HEADER_BYTES = 2;
const BYTES_PER_WORLD_TARGET = 18;

export interface WorldTargetState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radiusMetres: number;
  readonly heightMetres: number;
  readonly health: number;
  readonly maxHealth: number;
}

export function encodeWorldTargets(targets: readonly WorldTargetState[]): Uint8Array {
  const count = Math.min(targets.length, 0xff);
  const buffer = new ArrayBuffer(WORLD_TARGETS_HEADER_BYTES + count * BYTES_PER_WORLD_TARGET);
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.WorldTargets);
  view.setUint8(1, count);
  let at = WORLD_TARGETS_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    const target = targets[index]!;
    view.setUint16(at, target.id & 0xffff);
    view.setFloat32(at + 2, target.x);
    view.setFloat32(at + 6, target.y);
    view.setFloat32(at + 10, target.z);
    view.setUint8(at + 14, clamp(Math.round(target.radiusMetres * 100), 1, 255));
    view.setUint8(at + 15, clamp(Math.round(target.heightMetres * 50), 1, 255));
    view.setUint8(at + 16, clamp(Math.round(target.health), 0, 255));
    view.setUint8(at + 17, clamp(Math.round(target.maxHealth), 1, 255));
    at += BYTES_PER_WORLD_TARGET;
  }
  return new Uint8Array(buffer);
}

export function decodeWorldTargets(bytes: Uint8Array): WorldTargetState[] {
  if (bytes.byteLength < WORLD_TARGETS_HEADER_BYTES) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const available = Math.floor(
    (bytes.byteLength - WORLD_TARGETS_HEADER_BYTES) / BYTES_PER_WORLD_TARGET
  );
  const count = Math.min(view.getUint8(1), available);
  const targets: WorldTargetState[] = [];
  let at = WORLD_TARGETS_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    const x = view.getFloat32(at + 2);
    const y = view.getFloat32(at + 6);
    const z = view.getFloat32(at + 10);
    if ([x, y, z].every(Number.isFinite)) {
      targets.push({
        id: view.getUint16(at),
        x,
        y,
        z,
        radiusMetres: view.getUint8(at + 14) / 100,
        heightMetres: view.getUint8(at + 15) / 50,
        health: view.getUint8(at + 16),
        maxHealth: view.getUint8(at + 17),
      });
    }
    at += BYTES_PER_WORLD_TARGET;
  }
  return targets;
}

export function packetTypeOf(bytes: Uint8Array): number {
  return bytes.length > 0 ? bytes[0]! : 0;
}
