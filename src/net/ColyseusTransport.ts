// Colyseus-backed client transport — the adopted replacement for the
// disposable WebSocket one (decision: docs/plans/2026-08-03-colyseus-...md).
// Colyseus supplies the room, matchmaking and reconnection surface; the
// payload stays this project's own hand-packed bytes, so everything above
// ClientTransport is unchanged. The room name and message envelopes come from
// ColyseusProtocol.ts, shared with the server room so the two cannot drift.

import { Client, type Room } from "@colyseus/sdk";
import {
  COMMANDS_UP,
  GAME_ROOM,
  PACKET_DOWN,
  ROOM_INFO,
  type RoomInfo,
} from "./ColyseusProtocol.ts";
import type { ClientTransport, TransportMessageHandler } from "./Transport.ts";

export interface ColyseusJoinOptions {
  /**
   * The session token, or null to join as nobody.
   *
   * Set on `client.auth.token` before joining, which makes the SDK send it as an
   * Authorization header — the room's static onAuth resolves it to an account so
   * the session can be credited to a career. Optional on purpose: every
   * documented dev URL predates accounts and must keep working.
   */
  token?: string | null;
  /** Join this exact room instead of matchmaking. How a join code is honoured. */
  roomId?: string | null;
  /** Create a private room rather than joining a public one. */
  createPrivate?: boolean;
  /** Which queue to match in. No cross-play — the server filters on it. */
  inputClass?: "desktop" | "touch";
  /** Free-text label for a room this client creates. */
  label?: string | null;
}

export class ColyseusClientTransport implements ClientTransport {
  private room: Room | null = null;
  private closed = false;
  private messageHandler: TransportMessageHandler | null = null;
  private closeHandler: (() => void) | null = null;
  /**
   * The room's own facts, once it has told us.
   *
   * Held here rather than pushed through `ClientTransport`: that interface is
   * shared with the loopback and ws implementations used by the Node tests, and
   * neither has a concept of a Colyseus room. A caller that wants this reaches for
   * the concrete class, which `useGameClient` already constructs.
   */
  private info: RoomInfo | null = null;
  private infoHandler: ((info: RoomInfo) => void) | null = null;

  constructor(url: string, options: ColyseusJoinOptions = {}) {
    const client = new Client(url);
    // Before the join, not after: the SDK reads the token when it builds the
    // matchmaking request, so setting it afterwards would authenticate nothing.
    if (options.token !== null && options.token !== undefined) {
      client.auth.token = options.token;
    }
    const joinOptions = {
      inputClass: options.inputClass ?? "desktop",
      ...(options.createPrivate === true ? { visibility: "private" } : {}),
      ...(options.label !== null && options.label !== undefined ? { label: options.label } : {}),
    };
    // Three ways in, and they are genuinely different: a code means one specific
    // room, "create private" must never land in someone else's game, and the
    // default is ordinary matchmaking.
    const joining =
      options.roomId !== null && options.roomId !== undefined && options.roomId !== ""
        ? client.joinById(options.roomId, joinOptions)
        : options.createPrivate === true
          ? client.create(GAME_ROOM, joinOptions)
          : client.joinOrCreate(GAME_ROOM, joinOptions);
    void joining
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
        room.onMessage(ROOM_INFO, (info: RoomInfo) => {
          this.info = info;
          this.infoHandler?.(info);
        });
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

  /** The room's join code and label, or null until the room says. */
  get roomInfo(): RoomInfo | null {
    return this.info;
  }

  /**
   * Subscribe to the room's facts.
   *
   * Replays immediately if the message already arrived — the room sends it during
   * join, which can easily beat a React effect subscribing after mount, and a
   * subscription that silently misses the only send it will ever get is the kind
   * of bug that looks like the server never sent anything.
   */
  onRoomInfo(handler: (info: RoomInfo) => void): void {
    this.infoHandler = handler;
    if (this.info !== null) handler(this.info);
  }
}
