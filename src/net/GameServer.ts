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
  encodeSnapshot,
  encodeWelcome,
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

  private readonly transport: ServerTransport;
  private readonly peers = new Map<number, Peer>();
  private readonly commands = new Map<string, PlayerCommand>();
  private readonly catchUp = new Map<string, PlayerCommand>();
  private readonly snapshotPlayers: SnapshotPlayer[] = [];
  private readonly ticksPerPatch: number;
  private timer: ReturnType<typeof setInterval> | null = null;

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
    });

    transport.onMessage((connection, bytes) => {
      if (packetTypeOf(bytes) !== PacketType.Commands) return;
      const peer = this.peers.get(connection.id);
      if (peer === undefined) return;
      for (const command of decodeCommands(bytes)) {
        // Redundant resends are normal — a client repeats unacknowledged
        // commands — so anything already consumed OR already queued is dropped.
        if (command.tick <= peer.highestQueuedTick) {
          this.staleCommandsDropped += 1;
          continue;
        }
        peer.highestQueuedTick = command.tick;
        peer.queue.push(command);
      }
      peer.queue.sort((left, right) => left.tick - right.tick);
    });

    transport.onDisconnection((connection) => {
      this.peers.delete(connection.id);
      this.room.remove(String(connection.id));
    });
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
    this.snapshotPlayers.length = 0;
    for (const peer of this.peers.values()) {
      const motor = this.room.get(peer.roomId);
      if (motor === undefined) continue;
      this.snapshotPlayers.push({ id: peer.connection.id, state: motor.state });
    }
    if (this.snapshotPlayers.length === 0) return;
    // Each client needs its own acknowledgement, so the payload is re-encoded
    // per peer. At 24 bytes a player this is cheaper than a shared buffer plus
    // a patch, and it keeps the format single-branch.
    for (const peer of this.peers.values()) {
      peer.connection.send(
        encodeSnapshot(this.room.tick, peer.acknowledgedTick, this.snapshotPlayers)
      );
      this.snapshotsSent += 1;
    }
  }
}

function defaultSpawn(seat: number): { x: number; z: number } {
  const angle = seat * 1.4;
  return { x: Math.cos(angle) * 6, z: Math.sin(angle) * 6 };
}
