// Colyseus-backed client transport — the adopted replacement for the
// disposable WebSocket one (decision: docs/plans/2026-08-03-colyseus-...md).
// Colyseus supplies the room, matchmaking and reconnection surface; the
// payload stays this project's own hand-packed bytes, so everything above
// ClientTransport is unchanged. Message types and the room name live here so
// the server room and this client cannot drift apart.

import { Client, type Room } from "@colyseus/sdk";
import type { ClientTransport, TransportMessageHandler } from "./Transport.ts";

export const GAME_ROOM = "game";
/** Colyseus message envelopes; the codec's own packet type rides inside. */
export const COMMANDS_UP = 1;
export const PACKET_DOWN = 2;

export class ColyseusClientTransport implements ClientTransport {
  private room: Room | null = null;
  private closed = false;
  /**
   * While the join is in flight, keep only the newest batch — every batch
   * already carries the whole unacknowledged tail, so older ones are strictly
   * redundant. Same rule as the WebSocket transport's CONNECTING window, which
   * a matchmade join makes strictly longer.
   */
  private pending: Uint8Array | null = null;
  private messageHandler: TransportMessageHandler | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(url: string) {
    void new Client(url)
      .joinOrCreate(GAME_ROOM)
      .then((room) => {
        // close() during a pending join: leaving on resolve is what keeps an
        // HMR remount (construct -> close -> construct) from stranding a ghost
        // player in the room.
        if (this.closed) {
          void room.leave();
          return;
        }
        this.room = room;
        room.onMessage(PACKET_DOWN, (bytes: Uint8Array) => this.messageHandler?.(bytes));
        room.onLeave(() => {
          this.room = null;
          this.closeHandler?.();
        });
        if (this.pending !== null) {
          room.sendBytes(COMMANDS_UP, this.pending);
          this.pending = null;
        }
      })
      .catch(() => {
        this.closed = true;
        this.closeHandler?.();
      });
  }

  send(bytes: Uint8Array): void {
    if (this.room !== null) {
      this.room.sendBytes(COMMANDS_UP, bytes);
      return;
    }
    if (!this.closed) this.pending = bytes;
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closed = true;
    const room = this.room;
    this.room = null;
    if (room !== null) void room.leave();
  }

  get connected(): boolean {
    return this.room !== null;
  }
}
