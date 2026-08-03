// Throwaway authoritative server for the two-client session test.
//
// A `ws` server bound to the transport interface plus a fixed-tick loop. It has
// no rooms, no matchmaking, no reconnection and no persistence, which is the
// point: §5 defers the session framework until the §7 measurements exist, and
// this is the smallest thing that produces them.
//
// Run: node --experimental-strip-types --experimental-specifier-resolution=node \
//        tools/session-test/server.ts [port]

import { WebSocketServer, type WebSocket } from "ws";
import { GameServer } from "../../src/net/GameServer.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import { DEFAULT_MOTOR_TUNING, type MotorHeightSource } from "../../src/motor/MotorTypes.ts";
import type { ServerConnection, ServerTransport } from "../../src/net/Transport.ts";

const PORT = Number(process.argv[2] ?? 8787);
const ROOM_SPAN_METRES = 512;

/**
 * Rolling ground. The real Heightfield is not used here on purpose: it lives
 * behind the terrain spike's config and asset loading, and the session test is
 * about the network, not the map. Both sides must agree, so the client harness
 * uses the identical function.
 */
const terrain: MotorHeightSource = {
  cellSize: 2,
  sample: (x, z) => Math.sin(x * 0.03) * 2.5 + Math.cos(z * 0.021) * 3,
};

class WsServerTransport implements ServerTransport {
  private readonly server: WebSocketServer;
  private readonly connections = new Map<WebSocket, ServerConnection>();
  private nextId = 1;

  private connectionHandler: ((connection: ServerConnection) => void) | null = null;
  private messageHandler: ((connection: ServerConnection, bytes: Uint8Array) => void) | null =
    null;
  private disconnectionHandler: ((connection: ServerConnection) => void) | null = null;

  constructor(port: number) {
    this.server = new WebSocketServer({ port });
    this.server.on("connection", (socket) => {
      const id = this.nextId;
      this.nextId += 1;
      const connection: ServerConnection = {
        id,
        send: (bytes) => {
          if (socket.readyState === socket.OPEN) socket.send(bytes);
        },
        close: () => socket.close(),
      };
      this.connections.set(socket, connection);
      console.log(`player ${id} connected (${this.connections.size} online)`);
      this.connectionHandler?.(connection);

      socket.on("message", (data: Buffer) => {
        this.messageHandler?.(connection, new Uint8Array(data));
      });
      socket.on("close", () => {
        this.connections.delete(socket);
        console.log(`player ${id} left (${this.connections.size} online)`);
        this.disconnectionHandler?.(connection);
      });
    });
  }

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
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const RAPIER = await initRapier();
const transport = new WsServerTransport(PORT);
const server = new GameServer(RAPIER, createMotorWorld(RAPIER), terrain, transport, {
  sharedSurfaceSpanMetres: ROOM_SPAN_METRES,
  patchHz: 20,
});

const tickHz = Math.round(1 / DEFAULT_MOTOR_TUNING.fixedTimestepSeconds);
console.log(`session server on ws://localhost:${PORT} — ${tickHz} Hz tick, 20 Hz patch`);
console.log("open the harness in two browser tabs to drive it");
server.start();

// A fixed-tick loop that never reports its own health is how a server quietly
// falls behind, so print the load periodically.
setInterval(() => {
  if (server.room.size === 0) return;
  const budgetMs = 1000 / tickHz;
  const usedMs = server.room.motorMilliseconds + server.room.worldMilliseconds;
  console.log(
    `${server.room.size} online — tick ${server.room.tick}, ` +
      `${usedMs.toFixed(2)} ms/tick (${((usedMs / budgetMs) * 100).toFixed(1)}% budget), ` +
      `${server.snapshotsSent} snapshots, ${server.commandsDiscarded} inputs discarded`
  );
}, 5000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nshutting down");
    void server.stop().then(() => process.exit(0));
  });
}
