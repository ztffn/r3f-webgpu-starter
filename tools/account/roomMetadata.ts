// What a game room publishes about itself, and how a join code is made.
//
// SERVER ONLY. The metadata object is what the server browser reads, so every
// field here becomes public for a PUBLIC room — with one exception, `joinCode`,
// which is filtered out before any response (tools/account/lobbyApi.ts) and is the
// reason the listing is built server-side instead of by the client calling
// Colyseus's own matchmaking endpoint.

import crypto from "node:crypto";

/** Which control scheme a room accepts. No cross-play — design record 2.5. */
export type InputClass = "desktop" | "touch";

export interface RoomMetadata {
  /** Shown in the browser. Includes the map so the list reads at a glance. */
  label: string;
  map: string;
  weather: string;
  inputClass: InputClass;
  /** Hosted by a supporter rather than the project. */
  community: boolean;
  hostCallsign: string | null;
  /**
   * Present only on private rooms. NEVER serialised into an HTTP response —
   * lobbyApi builds its own listing type precisely so this cannot leak by
   * someone adding a spread.
   */
  joinCode?: string;
}

/**
 * Characters a join code may contain.
 *
 * No 0/O, 1/I/L, 5/S, 8/B, 2/Z. Codes get read aloud over voice comms and typed
 * from memory, and every one of those pairs is a support request waiting to
 * happen. 26 symbols over 6 places is about 300 million combinations, which is
 * ample when only live rooms are addressable.
 */
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";
const CODE_LENGTH = 6;

/**
 * A join code.
 *
 * `crypto.randomInt` rather than `Math.random`: the code is the only thing
 * protecting a private match, so it must not be predictable from another code
 * generated moments earlier.
 *
 * Minting stays here because it needs `node:crypto`; NORMALISING a typed code is
 * `normaliseJoinCode` in src/account/lobby.ts, because the lobby page has to
 * apply the same rule and cannot import from tools/.
 */
export function makeJoinCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export interface RoomOptions {
  visibility?: unknown;
  inputClass?: unknown;
  label?: unknown;
}

/**
 * Read the untrusted options a client passed to create a room.
 *
 * Everything is clamped or defaulted; nothing is taken on trust. A label is the
 * only free text, and it is length-limited and stripped of control characters
 * because it renders in every other player's server browser.
 */
export function readRoomOptions(options: RoomOptions | undefined): {
  isPrivate: boolean;
  inputClass: InputClass;
  label: string | null;
} {
  const raw = options ?? {};
  const label =
    typeof raw.label === "string"
      ? raw.label.replace(/[\p{C}]/gu, "").trim().slice(0, 32) || null
      : null;
  return {
    isPrivate: raw.visibility === "private",
    inputClass: raw.inputClass === "touch" ? "touch" : "desktop",
    label,
  };
}
