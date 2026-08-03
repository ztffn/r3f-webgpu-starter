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
