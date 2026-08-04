// Shared Colyseus wire-protocol constants.
//
// The one place the room name and message-type envelopes are defined, imported
// by the browser transport, the Node game server, and the benches alike. A
// neutral module with no SDK imports on purpose: the authoritative server must
// never pull the client SDK's module graph just to read three integers.

export const GAME_ROOM = "game";
/** Colyseus message envelopes; the codec's own packet type rides inside. */
export const COMMANDS_UP = 1;
export const PACKET_DOWN = 2;
/**
 * Room facts a client needs but the simulation does not: currently the private
 * game's join code.
 *
 * A COLYSEUS MESSAGE rather than a packet inside PACKET_DOWN, which is the
 * opposite of the choice made for weather in docs/12 §8.1 — so the difference is
 * worth stating. Weather is gameplay: fog is concealment, the authority layer owns
 * it, and it had to be reachable by a gameplay consumer and coverable by the Node
 * loopback tests. A join code is neither. Nothing in the simulation reads it, it
 * changes never, and it is per-client rather than per-room.
 *
 * Putting it in the codec would mean widening `SnapshotCodec`, `GameServer` and the
 * packet enum to carry a string that no simulation code will ever consult — and
 * those three files are exactly where feat/server-ballistics is working. This costs
 * one message envelope instead.
 */
export const ROOM_INFO = 3;

/** Payload of a ROOM_INFO message. JSON, because it is sent once per join. */
export interface RoomInfo {
  /** Present only for a private room. Absent means the room is public. */
  joinCode?: string;
}
