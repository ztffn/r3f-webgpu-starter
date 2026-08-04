// The community layer's shapes and rules: tagwall, friends, clans.
//
// Shared by the browser and the server, and pure, so the page that composes a
// post and the endpoint that stores it agree on what is allowed — the same
// one-rule-two-callers discipline `characters.ts` uses for the loadout. The
// client's copy is a courtesy; the server's call is the gate.
//
// Design record: docs/plans/2026-08-04-community-layer-design.md.

import type { TierId } from "./tiers.ts";

/** Longest a tagwall note may be. It is a note, not a forum post. */
export const POST_MAX = 280;

/** Clan tag: what appears beside a name, so it is short and unambiguous. */
export const CLAN_TAG_MIN = 2;
export const CLAN_TAG_MAX = 5;
export const CLAN_NAME_MIN = 3;
export const CLAN_NAME_MAX = 32;

/** Rate limits, enforced server-side. The client never sees these fire. */
export const POSTS_PER_HOUR = 10;
export const POSTS_PER_WALL_PER_HOUR = 3;
export const OUTGOING_REQUESTS_MAX = 50;

/** One note on someone's wall, as the client sees it. */
export interface ProfilePost {
  id: number;
  authorId: number;
  authorCallsign: string;
  authorTier: TierId;
  /** Plain text. NEVER rendered as markup — see the design record §3.2. */
  body: string;
  createdAt: string;
}

export type FriendState = "none" | "pending_out" | "pending_in" | "friends" | "blocked";

export interface Friend {
  id: number;
  callsign: string;
  tier: TierId;
  /** Present only for accepted friends, and only when they are in a game. */
  roomId?: string;
}

export interface ClanSummary {
  id: number;
  tag: string;
  name: string;
  memberCount: number;
}

export type ClanRole = "leader" | "officer" | "member";

export interface ClanMember {
  id: number;
  callsign: string;
  tier: TierId;
  role: ClanRole;
  joinedAt: string;
}

export interface Clan extends ClanSummary {
  founderId: number;
  createdAt: string;
  members: ClanMember[];
}

/**
 * One entry of the derived activity feed.
 *
 * Derived, never stored: every field here already has a home in another table,
 * and a duplicated fact is a fact that can disagree with itself (design record
 * §3.5).
 */
export interface ActivityEntry {
  kind: "medal" | "post" | "clan";
  at: string;
  /** Human line, already resolved server-side so the client renders one string. */
  text: string;
}

export interface Problem {
  field: string;
  message: string;
}

/**
 * Validate a tagwall note.
 *
 * Rejects empty and whitespace-only bodies as well as long ones: a wall full of
 * blank notes is the cheapest way to make someone's page unusable.
 */
export function validatePost(body: unknown): Problem | null {
  if (typeof body !== "string") return { field: "body", message: "Write something." };
  const trimmed = body.trim();
  if (trimmed.length === 0) return { field: "body", message: "Write something." };
  if (trimmed.length > POST_MAX) {
    return { field: "body", message: `At most ${POST_MAX} characters.` };
  }
  return null;
}

/** Strip control characters and collapse runs of blank lines. Never markup. */
export function normalisePost(body: string): string {
  return body
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, POST_MAX);
}

/**
 * Validate a clan tag.
 *
 * Same charset as callsigns and insignia, for the same reason: a tag is read off
 * a scoreboard at a glance and shouted over voice, and homoglyph impersonation
 * is a real problem in games with clans (`accountTypes.ts`).
 */
export function validateClanTag(raw: unknown): Problem | null {
  if (typeof raw !== "string") return { field: "tag", message: "Choose a tag." };
  const tag = raw.trim().toUpperCase();
  if (tag.length < CLAN_TAG_MIN || tag.length > CLAN_TAG_MAX) {
    return {
      field: "tag",
      message: `${CLAN_TAG_MIN} to ${CLAN_TAG_MAX} characters.`,
    };
  }
  if (!/^[A-Z0-9]+$/.test(tag)) {
    return { field: "tag", message: "Capital letters and digits only." };
  }
  return null;
}

export function validateClanName(raw: unknown): Problem | null {
  if (typeof raw !== "string") return { field: "name", message: "Name the clan." };
  const name = raw.replace(/[\p{C}]/gu, "").trim();
  if (name.length < CLAN_NAME_MIN || name.length > CLAN_NAME_MAX) {
    return {
      field: "name",
      message: `${CLAN_NAME_MIN} to ${CLAN_NAME_MAX} characters.`,
    };
  }
  return null;
}

export function normaliseClanTag(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CLAN_TAG_MAX);
}

export function normaliseClanName(raw: string): string {
  return raw.replace(/[\p{C}]/gu, "").trim().slice(0, CLAN_NAME_MAX);
}
