// Lobby, server-browser and leaderboard wire shapes, plus the join-code rule.
//
// Shared by the browser and the server, and declared once for the reason the
// mirrored copies proved: `ServerListing` and `LeaderboardRow` existed verbatim on
// both sides, agreeing only because somebody kept them in step by hand. A field
// added to one and not the other is a blank column, not a compile error.
//
// Separate from accountTypes.ts on the same line the server draws between
// lobbyApi.ts and api.ts: these describe the MATCHMAKER's view, not an account.

import type { TierId } from "./tiers.ts";

/** One row of the server browser. Deliberately not Colyseus's IRoomCache. */
export interface ServerListing {
  roomId: string;
  label: string;
  map: string;
  weather: string;
  inputClass: string;
  players: number;
  maxPlayers: number;
  /** True when a supporter is hosting it rather than the project. */
  community: boolean;
  hostCallsign: string | null;
  locked: boolean;
}

export interface BoardSummary {
  id: string;
  label: string;
  /**
   * Whether anything currently writes this stat.
   *
   * The server reports it so the page can distinguish "nobody has done this yet"
   * from "nothing records this yet" — an empty kills board would otherwise read as
   * nobody having ever killed anyone, which is not what is true.
   */
  populated: boolean;
}

export interface LeaderboardRow {
  rank: number;
  id: number;
  callsign: string;
  tier: TierId;
  value: number;
}

export interface Leaderboard extends BoardSummary {
  board: string;
  rows: LeaderboardRow[];
}

/**
 * Normalise a typed join code.
 *
 * Shared rather than reimplemented per caller: the field the code is typed into,
 * the request that resolves it and the server that compares it all have to agree
 * on what "the same code" means, and three `toUpperCase()` calls that happen to
 * match today is not agreement. Punctuation and spaces are dropped because a code
 * read aloud comes back written as "A-4C 7QK".
 */
export function normaliseJoinCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
