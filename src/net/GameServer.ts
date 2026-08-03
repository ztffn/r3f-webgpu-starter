// Authoritative room loop.
//
// Owns the only real simulation: it steps one MotorRoom at a fixed tick and
// broadcasts snapshots at its own patch rate, which is deliberately a separate
// number so §7.2's "behaviour as tick and patch rates diverge" is measurable.
//
// Transport agnostic on purpose — it is handed a ServerTransport and never
// learns whether that is WebSocket, WebTransport or an in-process loopback.
// The Node integration test drives it through the same interface a browser does.

import type RAPIER from "@dimforge/rapier3d-compat";
import { MotorRoom } from "../motor/MotorRoom.ts";
import {
  DEFAULT_MOTOR_TUNING,
  type MotorHeightSource,
  type MotorTuning,
  type PlayerCommand,
} from "../motor/MotorTypes.ts";
import {
  PacketType,
  decodeCommands,
  decodeSetVisualDial,
  encodeSnapshot,
  encodeVisualDials,
  encodeWelcome,
  encodeWorldState,
  packetTypeOf,
  type SnapshotPlayer,
} from "./SnapshotCodec.ts";
import type { ServerConnection, ServerTransport } from "./Transport.ts";

export interface GameServerOptions {
  readonly tuning?: MotorTuning;
  readonly sharedSurfaceSpanMetres?: number;
  /** Snapshots per second. Independent of the simulation tick rate. */
  readonly patchHz?: number;
  readonly spawn?: (seat: number) => { x: number; y?: number; z: number };
  /**
   * The room's weather, as an index into the presentation side's preset table
   * (`WEATHER_PRESET_IDS` in `src/df2/weather.ts`). Opaque here on purpose: this
   * layer imports nothing from the render side, so it carries the number and
   * never learns which sky it names. Defaults to 0, the neutral daylight preset.
   */
  readonly weatherIndex?: number;
  /**
   * Legal range per visual dial id, from `VISUAL_DIAL_RANGES` in
   * `src/df2/visualDials.ts`. Injected rather than imported for the same reason
   * `weatherIndex` is a number: the authority layer stays free of the render side.
   *
   * Its ABSENCE is also the off switch. A dial write is refused when there is no
   * range to check it against, so a server that has not been handed these cannot
   * be talked into setting anything — the capability has to be wired on purpose.
   */
  readonly visualDialRanges?: readonly { readonly min: number; readonly max: number }[];
  /**
   * Let connected clients change the room's visual dials.
   *
   * OFF BY DEFAULT, and it must stay that way: a client that can set the room's
   * fog can clear everyone's concealment, which is griefing rather than cheating
   * and is worse for being invisible. A development server opts in; a public one
   * never does. Server-side game code can call `setVisualDial` regardless — this
   * gates the CLIENT path only.
   */
  readonly allowClientVisualDials?: boolean;
}

interface Peer {
  readonly connection: ServerConnection;
  readonly roomId: string;
  /** Commands received but not yet consumed, ordered by tick. */
  readonly queue: PlayerCommand[];
  acknowledgedTick: number;
  /**
   * Highest tick ever accepted into the queue, which is NOT the same as the
   * highest consumed. A client resends its unacknowledged tail, so a command
   * still sitting in the queue arrives again and passes an acknowledged-tick
   * check; without this it is queued twice, the queue grows until the overflow
   * guard discards real input, and the server falls behind for good.
   */
  highestQueuedTick: number;
}

const DEFAULT_PATCH_HZ = 20;

/**
 * Command buffer management. Draining exactly one command per tick is the
 * obvious implementation and it is wrong: every lost packet arrives later as a
 * resend, the queue deepens by one, and it never recovers, so the server falls
 * permanently further behind the client. These bound it.
 */
const TARGET_BUFFER_DEPTH = 2;
const MAX_COMMANDS_PER_TICK = 2;
/** Beyond this the client is unreachably far ahead; drop the oldest input. */
const MAX_QUEUED_COMMANDS = 12;

export class GameServer {
  readonly room: MotorRoom;
  readonly patchHz: number;

  /** Snapshots broadcast and command packets dropped as stale. Telemetry. */
  snapshotsSent = 0;
  staleCommandsDropped = 0;
  /** Inputs thrown away because a client's queue overflowed. Should stay at 0. */
  commandsDiscarded = 0;
  /** Packets a peer sent that could not be parsed at all. */
  malformedPacketsDropped = 0;
  /** Client dial writes refused: not allowed, unknown id, or out of range. */
  visualDialWritesRefused = 0;
  /** Dial packets broadcast. One per patch tick at most, however fast a client talks. */
  visualDialPacketsSent = 0;

  private readonly transport: ServerTransport;
  private readonly peers = new Map<number, Peer>();
  private readonly commands = new Map<string, PlayerCommand>();
  private readonly catchUp = new Map<string, PlayerCommand>();
  private readonly snapshotPlayers: SnapshotPlayer[] = [];
  private readonly ticksPerPatch: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private weather: number;
  private readonly visualDialRanges: readonly { readonly min: number; readonly max: number }[];
  private readonly allowClientVisualDials: boolean;
  /** Only the dials somebody has actually moved. An untouched room holds none. */
  private readonly visualDials = new Map<number, number>();
  /**
   * Changed dials awaiting a broadcast.
   *
   * COALESCED TO THE PATCH TICK rather than sent per message, and that is the
   * whole reason this set exists: a dragged slider fires an input event per pixel,
   * so forwarding each one immediately costs one send per client per event — about
   * 3800 sends a second at 64 players from one admin's mouse. Batching here bounds
   * it to the patch rate no matter how fast a client talks, which also means a
   * hostile client cannot use this as an amplifier.
   */
  private readonly dirtyVisualDials = new Set<number>();
  /** A reset happened; the next flush must replace rather than merge. */
  private resendCompleteVisualDials = false;

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    heightSource: MotorHeightSource,
    transport: ServerTransport,
    options: GameServerOptions = {}
  ) {
    const tuning = options.tuning ?? DEFAULT_MOTOR_TUNING;
    this.transport = transport;
    this.patchHz = options.patchHz ?? DEFAULT_PATCH_HZ;
    this.ticksPerPatch = Math.max(
      1,
      Math.round(1 / tuning.fixedTimestepSeconds / this.patchHz)
    );
    this.room = new MotorRoom(rapier, world, heightSource, {
      tuning,
      ...(options.sharedSurfaceSpanMetres !== undefined
        ? { sharedSurfaceSpanMetres: options.sharedSurfaceSpanMetres }
        : {}),
    });
    const spawn = options.spawn ?? defaultSpawn;
    this.weather = (options.weatherIndex ?? 0) & 0xff;
    this.visualDialRanges = options.visualDialRanges ?? [];
    this.allowClientVisualDials = options.allowClientVisualDials ?? false;

    transport.onConnection((connection) => {
      const roomId = String(connection.id);
      const motor = this.room.add(roomId, spawn(connection.id));
      this.peers.set(connection.id, {
        connection,
        roomId,
        queue: [],
        acknowledgedTick: 0,
        highestQueuedTick: -1,
      });
      // The resolved feet position, not the requested spawn: the motor drops
      // the player onto the terrain, so the client must be told where they
      // actually landed or it starts its prediction off the ground.
      connection.send(encodeWelcome(connection.id, this.room.tick, motor.state.position));
      // Right after the welcome, because the client needs the room's sky before
      // its first frame. Fog is concealment in this game, so two players in one
      // match seeing different fog ranges is a fairness bug, not a cosmetic one.
      connection.send(encodeWorldState(this.describeWorld()));
      // The FULL override set, so a late joiner sees the room as it has been
      // dialled rather than as its preset alone describes. Empty in the ordinary
      // case, which costs two bytes.
      if (this.visualDials.size > 0) {
        connection.send(encodeVisualDials(this.visualDials, true));
      }
    });

    transport.onMessage((connection, bytes) => {
      const type = packetTypeOf(bytes);
      if (type === PacketType.SetVisualDial) {
        this.receiveVisualDial(connection, bytes);
        return;
      }
      if (type !== PacketType.Commands) return;
      const peer = this.peers.get(connection.id);
      if (peer === undefined) return;
      // The codec clamps to the buffer, but this is a socket handler: anything
      // that escapes it is an uncaught exception and a dead room for everyone.
      // Belt and braces, deliberately.
      let incoming: PlayerCommand[];
      try {
        incoming = decodeCommands(bytes);
      } catch {
        this.malformedPacketsDropped += 1;
        return;
      }
      for (const command of incoming) {
        // Redundant resends are normal — a client repeats unacknowledged
        // commands — so anything already consumed OR already queued is dropped.
        if (command.tick <= peer.highestQueuedTick) {
          this.staleCommandsDropped += 1;
          continue;
        }
        peer.highestQueuedTick = command.tick;
        peer.queue.push(command);
      }
      // Trimmed here as well as in `tick`, or a burst inside one tick window
      // allocates without limit and pays an O(n log n) sort for the privilege.
      if (peer.queue.length > MAX_QUEUED_COMMANDS) {
        this.commandsDiscarded += peer.queue.length - MAX_QUEUED_COMMANDS;
        peer.queue.splice(0, peer.queue.length - MAX_QUEUED_COMMANDS);
      }
      peer.queue.sort((left, right) => left.tick - right.tick);
    });

    transport.onDisconnection((connection) => {
      this.peers.delete(connection.id);
      this.room.remove(String(connection.id));
    });
  }

  /** The room's weather. Meaning lives in `src/df2/weather.ts`; a number here. */
  get weatherIndex(): number {
    return this.weather;
  }

  /** One place the world-state packet is described, so join and change cannot drift. */
  private describeWorld(): { weatherIndex: number; clientDialsAllowed: boolean } {
    return {
      weatherIndex: this.weather,
      // BOTH conditions, the same pair `receiveVisualDial` enforces. Advertising a
      // capability the intake would refuse is worse than not having it: the panel
      // would present live-looking sliders that silently do nothing.
      clientDialsAllowed: this.allowClientVisualDials && this.visualDialRanges.length > 0,
    };
  }

  /**
   * Changes the room's weather and tells everyone connected.
   *
   * ON CHANGE ONLY — there is no periodic rebroadcast, so a client that loses
   * this packet keeps the old sky until it reconnects. That is the right trade
   * for something that changes a handful of times a match: the alternative is
   * paying for it every patch, forever, to say nothing happened.
   */
  setWeather(index: number): void {
    const next = index & 0xff;
    if (next === this.weather) return;
    this.weather = next;
    const bytes = encodeWorldState(this.describeWorld());
    for (const peer of this.peers.values()) peer.connection.send(bytes);
  }

  /** The room's visual dial overrides. Sparse: only what has been moved. */
  get visualDialOverrides(): ReadonlyMap<number, number> {
    return this.visualDials;
  }

  /**
   * Sets one visual dial for the whole room. THE SERVER-SIDE ENTRY POINT — game
   * code, a round system or an admin console calls this directly and is trusted;
   * the client path goes through `receiveVisualDial`, which gates and then lands
   * here. Returns the clamped value, or null if the id or value was unusable.
   */
  setVisualDial(id: number, value: number): number | null {
    const range = this.visualDialRanges[id];
    if (range === undefined || !Number.isFinite(value)) return null;
    const clamped = Math.min(range.max, Math.max(range.min, value));
    if (this.visualDials.get(id) === clamped) return clamped;
    this.visualDials.set(id, clamped);
    this.dirtyVisualDials.add(id);
    return clamped;
  }

  /**
   * Drops every override, returning the room to its preset.
   *
   * Broadcast as a COMPLETE set rather than a delta, because a delta cannot say
   * "this dial is no longer overridden" — an absent id means unchanged.
   */
  resetVisualDials(): void {
    if (this.visualDials.size === 0) return;
    this.visualDials.clear();
    this.dirtyVisualDials.clear();
    this.resendCompleteVisualDials = true;
  }

  /**
   * A client asking to change a dial. Refused unless the server opted in AND was
   * handed the ranges to check against — two conditions rather than one, because
   * the consequence of getting this wrong is a player clearing everyone's fog.
   *
   * Refusals are SILENT and counted. Telling a client which packet was rejected
   * tells it what to try next, and there is nothing an honest client learns from
   * the answer: an admin panel that is out of step with the server it is talking
   * to is a development mistake, visible in this counter.
   */
  private receiveVisualDial(connection: ServerConnection, bytes: Uint8Array): void {
    if (!this.allowClientVisualDials || !this.peers.has(connection.id)) {
      this.visualDialWritesRefused += 1;
      return;
    }
    const request = decodeSetVisualDial(bytes);
    if (request === null || this.setVisualDial(request.id, request.value) === null) {
      this.visualDialWritesRefused += 1;
    }
  }

  /** Advances one simulation tick and broadcasts if this tick is a patch tick. */
  tick(): void {
    this.commands.clear();
    for (const peer of this.peers.values()) {
      if (peer.queue.length > MAX_QUEUED_COMMANDS) {
        const overflow = peer.queue.length - MAX_QUEUED_COMMANDS;
        peer.queue.splice(0, overflow);
        this.commandsDiscarded += overflow;
      }
      // One command per tick normally; a second only while catching up, so a
      // resend burst drains instead of accumulating.
      const drain = peer.queue.length > TARGET_BUFFER_DEPTH ? MAX_COMMANDS_PER_TICK : 1;
      let consumed: PlayerCommand | undefined;
      for (let index = 0; index < drain; index += 1) {
        const next = peer.queue.shift();
        if (next === undefined) break;
        // Catch-up steps run immediately so the extra input is simulated, not
        // silently dropped; only the last one rides this tick's batch.
        if (consumed !== undefined) {
          this.catchUp.set(peer.roomId, consumed);
          this.room.step(this.catchUp);
          this.catchUp.clear();
        }
        consumed = next;
      }
      if (consumed === undefined) continue;
      this.commands.set(peer.roomId, consumed);
      peer.acknowledgedTick = consumed.tick;
    }
    this.room.step(this.commands);
    if (this.room.tick % this.ticksPerPatch === 0) this.broadcast();
  }

  start(): void {
    if (this.timer !== null) return;
    const intervalMs = this.room.tuning.fixedTimestepSeconds * 1000;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.transport.close();
    this.room.dispose();
  }

  private broadcast(): void {
    // BEFORE the snapshot, and outside its early return: a dial change has to go
    // out even on a patch tick where no motor produced a snapshot, or an admin
    // dialling an empty room silently loses the edit.
    this.flushVisualDials();

    this.snapshotPlayers.length = 0;
    for (const peer of this.peers.values()) {
      const motor = this.room.get(peer.roomId);
      if (motor === undefined) continue;
      this.snapshotPlayers.push({ id: peer.connection.id, state: motor.state });
    }
    if (this.snapshotPlayers.length === 0) return;
    // Each client needs its own acknowledgement, so the payload is re-encoded
    // per peer. At 27 bytes a player this is cheaper than a shared buffer plus
    // a patch, and it keeps the format single-branch.
    for (const peer of this.peers.values()) {
      peer.connection.send(
        encodeSnapshot(this.room.tick, peer.acknowledgedTick, this.snapshotPlayers)
      );
      this.snapshotsSent += 1;
    }
  }

  /** Sends whatever changed since the last patch tick, to everyone. */
  private flushVisualDials(): void {
    let bytes: Uint8Array;
    if (this.resendCompleteVisualDials) {
      this.resendCompleteVisualDials = false;
      this.dirtyVisualDials.clear();
      bytes = encodeVisualDials(this.visualDials, true);
    } else if (this.dirtyVisualDials.size > 0) {
      const changed = new Map<number, number>();
      for (const id of this.dirtyVisualDials) {
        const value = this.visualDials.get(id);
        if (value !== undefined) changed.set(id, value);
      }
      this.dirtyVisualDials.clear();
      bytes = encodeVisualDials(changed, false);
    } else {
      return;
    }
    for (const peer of this.peers.values()) peer.connection.send(bytes);
    this.visualDialPacketsSent += 1;
  }
}

function defaultSpawn(seat: number): { x: number; z: number } {
  const angle = seat * 1.4;
  return { x: Math.cos(angle) * 6, z: Math.sin(angle) * 6 };
}
