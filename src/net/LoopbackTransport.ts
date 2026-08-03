// In-process transport with a simulated network.
//
// Exists so the authority model can be tested without sockets: latency, jitter
// and loss are parameters here, which is what makes §7.3 (correction rate and
// magnitude under representative latency and loss) measurable in a unit test
// rather than only against a live server.
//
// Delivery is driven by an explicit clock, not by timers, so a test advancing
// 600 ticks does not take ten seconds of wall time.

import type { ClientTransport, ServerConnection, ServerTransport } from "./Transport.ts";

export interface LinkConditions {
  /** One-way delay in milliseconds. */
  latencyMs?: number;
  /** Uniform jitter added to the delay, in milliseconds. */
  jitterMs?: number;
  /** Fraction of packets dropped, 0 to 1. */
  loss?: number;
  /** Deterministic source for jitter and loss, so a test result is stable. */
  random?: () => number;
}

interface InFlight {
  deliverAt: number;
  bytes: Uint8Array;
  toServer: boolean;
  connectionId: number;
}

export class LoopbackNetwork implements ServerTransport {
  private nowMs = 0;
  private nextId = 1;
  private readonly inFlight: InFlight[] = [];
  private readonly clients = new Map<number, LoopbackClient>();
  private readonly connections = new Map<number, ServerConnection>();

  private connectionHandler: ((connection: ServerConnection) => void) | null = null;
  private messageHandler: ((connection: ServerConnection, bytes: Uint8Array) => void) | null =
    null;
  private disconnectionHandler: ((connection: ServerConnection) => void) | null = null;

  connect(conditions: LinkConditions = {}): ClientTransport {
    const id = this.nextId;
    this.nextId += 1;
    const client = new LoopbackClient(this, id, conditions);
    this.clients.set(id, client);

    const connection: ServerConnection = {
      id,
      send: (bytes) => this.queue(bytes, false, id),
      close: () => this.disconnect(id),
    };
    this.connections.set(id, connection);
    this.connectionHandler?.(connection);
    return client;
  }

  disconnect(id: number): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    this.clients.get(id)?.markClosed();
    this.clients.delete(id);
    this.disconnectionHandler?.(connection);
  }

  /** Advances the simulated clock and delivers everything now due. */
  advance(deltaMs: number): void {
    this.nowMs += deltaMs;
    let index = 0;
    while (index < this.inFlight.length) {
      const packet = this.inFlight[index]!;
      if (packet.deliverAt > this.nowMs) {
        index += 1;
        continue;
      }
      this.inFlight.splice(index, 1);
      if (packet.toServer) {
        const connection = this.connections.get(packet.connectionId);
        if (connection !== undefined) this.messageHandler?.(connection, packet.bytes);
      } else {
        this.clients.get(packet.connectionId)?.deliver(packet.bytes);
      }
    }
  }

  queue(bytes: Uint8Array, toServer: boolean, connectionId: number): void {
    const client = this.clients.get(connectionId);
    const conditions = client?.conditions ?? {};
    const random = conditions.random ?? Math.random;
    if ((conditions.loss ?? 0) > 0 && random() < (conditions.loss ?? 0)) return;
    const jitter = (conditions.jitterMs ?? 0) * random();
    this.inFlight.push({
      deliverAt: this.nowMs + (conditions.latencyMs ?? 0) + jitter,
      bytes,
      toServer,
      connectionId,
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

  async close(): Promise<void> {
    for (const id of [...this.connections.keys()]) this.disconnect(id);
    this.inFlight.length = 0;
  }
}

class LoopbackClient implements ClientTransport {
  connected = true;

  readonly conditions: LinkConditions;

  private readonly network: LoopbackNetwork;
  private readonly id: number;
  private messageHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  // Parameter properties are not allowed: `--experimental-strip-types` runs in
  // strip-only mode and rejects them outright (docs/10 §9.1).
  constructor(network: LoopbackNetwork, id: number, conditions: LinkConditions) {
    this.network = network;
    this.id = id;
    this.conditions = conditions;
  }

  send(bytes: Uint8Array): void {
    if (!this.connected) return;
    this.network.queue(bytes, true, this.id);
  }

  deliver(bytes: Uint8Array): void {
    this.messageHandler?.(bytes);
  }

  markClosed(): void {
    this.connected = false;
    this.closeHandler?.();
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (!this.connected) return;
    this.network.disconnect(this.id);
  }
}
