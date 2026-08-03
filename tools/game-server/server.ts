// Authoritative Colyseus game server on the real prepared terrain.
//
// Colyseus owns rooms, matchmaking and connection lifecycle; each GameRoom
// bridges its clients onto the transport seam and hosts one untouched
// GameServer, so the simulation, codec and command-queue behaviour are the
// exact code the loopback tests drive. The hot path is raw bytes both ways
// (patchRate null, no Schema state), per the 2026-08-03 adoption record.
//
// Run: npm run game:server   (or: node --experimental-strip-types
//        --experimental-specifier-resolution=node tools/game-server/server.ts [port])

import { Room, Server, type Client } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameServer } from "../../src/net/GameServer.ts";
import {
  COMMANDS_UP,
  GAME_ROOM,
  PACKET_DOWN,
} from "../../src/net/ColyseusProtocol.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import { DEFAULT_MOTOR_TUNING } from "../../src/motor/MotorTypes.ts";
import type { ServerConnection, ServerTransport } from "../../src/net/Transport.ts";
import { TERRAIN_SLUG } from "../../src/df2/config.ts";
import { loadServerTerrain } from "./terrain.ts";

const PORT = Number(process.argv[2] ?? 2567);
const PATCH_HZ = 20;
/** The whole tile: the client walks an endlessly tiling map, the server's
 * static collider has real edges, so cover all of it. */
const SURFACE_SPAN_METRES = 2048;

const RAPIER = await initRapier();
const terrain = loadServerTerrain(TERRAIN_SLUG);
const tickMs = DEFAULT_MOTOR_TUNING.fixedTimestepSeconds * 1000;

/** Per-room adapter from Colyseus callbacks onto the project transport seam. */
class RoomBridge implements ServerTransport {
  connectionHandler: ((connection: ServerConnection) => void) | null = null;
  messageHandler: ((connection: ServerConnection, bytes: Uint8Array) => void) | null = null;
  disconnectionHandler: ((connection: ServerConnection) => void) | null = null;

  onConnection(handler: (connection: ServerConnection) => void): void {
    this.connectionHandler = handler;
  }
  onMessage(handler: (connection: ServerConnection, bytes: Uint8Array) => void): void {
    this.messageHandler = handler;
  }
  onDisconnection(handler: (connection: ServerConnection) => void): void {
    this.disconnectionHandler = handler;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class GameRoom extends Room {
  maxClients = 64;
  patchRate = null;

  private readonly bridge = new RoomBridge();
  private readonly connections = new Map<string, ServerConnection>();
  private nextId = 1;
  private game!: GameServer;

  onCreate(): void {
    this.game = new GameServer(RAPIER, createMotorWorld(RAPIER), terrain, this.bridge, {
      sharedSurfaceSpanMetres: SURFACE_SPAN_METRES,
      patchHz: PATCH_HZ,
    });
    this.onMessageBytes(COMMANDS_UP, (client: Client, bytes: Uint8Array) => {
      const connection = this.connections.get(client.sessionId);
      if (connection !== undefined) this.bridge.messageHandler?.(connection, bytes);
    });
    // The room clock drives the fixed tick instead of GameServer.start(), so
    // disposal and lifetime belong to Colyseus.
    this.setSimulationInterval(() => this.game.tick(), tickMs);
    // A fixed-tick loop that never reports its own health quietly falls behind.
    this.clock.setInterval(() => {
      if (this.game.room.size === 0) return;
      const usedMs = this.game.room.motorMilliseconds + this.game.room.worldMilliseconds;
      console.log(
        `[${this.roomId}] ${this.game.room.size} online — tick ${this.game.room.tick}, ` +
          `${usedMs.toFixed(2)} ms/tick (${((usedMs / tickMs) * 100).toFixed(1)}% budget), ` +
          `${this.game.snapshotsSent} snapshots, ` +
          `${this.game.commandsDiscarded} discarded, ` +
          `${this.game.malformedPacketsDropped} malformed`
      );
    }, 5000);
  }

  onJoin(client: Client): void {
    const id = this.nextId;
    this.nextId += 1;
    const connection: ServerConnection = {
      id,
      send: (bytes) => client.sendBytes(PACKET_DOWN, bytes),
      close: () => client.leave(),
    };
    this.connections.set(client.sessionId, connection);
    this.bridge.connectionHandler?.(connection);
    console.log(`[${this.roomId}] player ${id} joined (${this.connections.size} online)`);
  }

  onLeave(client: Client): void {
    const connection = this.connections.get(client.sessionId);
    if (connection === undefined) return;
    this.connections.delete(client.sessionId);
    this.bridge.disconnectionHandler?.(connection);
    console.log(
      `[${this.roomId}] player ${connection.id} left (${this.connections.size} online)`
    );
  }

  async onDispose(): Promise<void> {
    await this.game.stop();
  }
}

const server = new Server({ transport: new WebSocketTransport() });
server.define(GAME_ROOM, GameRoom);
await server.listen(PORT);
console.log(
  `game server on ws://localhost:${PORT} — ${TERRAIN_SLUG}, ` +
    `${Math.round(1000 / tickMs)} Hz tick, ${PATCH_HZ} Hz patch`
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nshutting down");
    void server.gracefullyShutdown();
  });
}
