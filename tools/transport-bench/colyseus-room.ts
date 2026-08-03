// Colyseus 0.17 half of the transport bench: adapts a Colyseus Room onto the
// project's ServerTransport seam so the IDENTICAL GameServer runs behind it.
// Hot path is raw bytes both ways (onMessageBytes up, client.sendBytes down)
// with patchRate null and no Schema state — exactly the §5 provisional shape:
// Colyseus for rooms/lifecycle, hand-packed binary for the simulation.

import { Room, Server, type Client } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import type { ServerConnection, ServerTransport } from "../../src/net/Transport.ts";

/** Message types on the wire; the payload stays the project's own codec bytes. */
const COMMANDS_UP = 1;
const PACKET_DOWN = 2;

class BridgeTransport implements ServerTransport {
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

const bridge = new BridgeTransport();
const connections = new Map<string, ServerConnection>();
let nextId = 1;

class BenchRoom extends Room {
  maxClients = 128;
  patchRate = null;
  autoDispose = false;

  onCreate(): void {
    this.onMessageBytes(COMMANDS_UP, (client: Client, bytes: Uint8Array) => {
      const connection = connections.get(client.sessionId);
      if (connection !== undefined) bridge.messageHandler?.(connection, bytes);
    });
  }

  onJoin(client: Client): void {
    const id = nextId;
    nextId += 1;
    const connection: ServerConnection = {
      id,
      send: (bytes) => client.sendBytes(PACKET_DOWN, bytes),
      close: () => client.leave(),
    };
    connections.set(client.sessionId, connection);
    bridge.connectionHandler?.(connection);
  }

  onLeave(client: Client): void {
    const connection = connections.get(client.sessionId);
    if (connection === undefined) return;
    connections.delete(client.sessionId);
    bridge.disconnectionHandler?.(connection);
  }
}

export async function createColyseusTransport(
  port: number,
  useUwebsockets: boolean
): Promise<{ transport: ServerTransport; stop: () => Promise<void> }> {
  const transport = useUwebsockets
    ? new (await import("@colyseus/uwebsockets-transport")).uWebSocketsTransport()
    : new WebSocketTransport();
  const gameServer = new Server({ transport });
  gameServer.define("bench", BenchRoom);
  await gameServer.listen(port);
  return {
    transport: bridge,
    stop: () => gameServer.gracefullyShutdown(false),
  };
}
