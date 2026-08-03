// Colyseus-backed client transport — the adopted replacement for the
// disposable WebSocket one (decision: docs/plans/2026-08-03-colyseus-...md).
// Colyseus supplies the room, matchmaking and reconnection surface; the
// payload stays this project's own hand-packed bytes, so everything above
// ClientTransport is unchanged. The room name and message envelopes come from
// ColyseusProtocol.ts, shared with the server room so the two cannot drift.

import { Client, type Room } from "@colyseus/sdk";
import { COMMANDS_UP, GAME_ROOM, PACKET_DOWN } from "./ColyseusProtocol.ts";
import type { ClientTransport, TransportMessageHandler } from "./Transport.ts";

export class ColyseusClientTransport implements ClientTransport {
  private room: Room | null = null;
  private closed = false;
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
      })
      .catch(() => {
        this.closed = true;
        this.closeHandler?.();
      });
  }

  send(bytes: Uint8Array): void {
    // GameClient gates its sends on `connected`, so nothing arrives pre-join —
    // and if something did, it would be a redundant tail batch, safe to drop.
    this.room?.sendBytes(COMMANDS_UP, bytes);
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
