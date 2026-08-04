// The account shapes shared by the browser and the server.
//
// No imports beyond ./tiers, so this file is safe in both a bundle and in Node —
// the same discipline src/motor/ and src/net/ keep, and for the same reason: the
// server resolves an account and the client renders one, and if they disagree
// about the shape it shows up as a missing field on a profile page rather than as
// an error. The DB row types live in tools/account/database.ts; these are the
// wire/API shapes, which are deliberately not the same thing.

import type { TierId } from "./tiers.ts";

/** How long a callsign may be. Enforced by `validateCallsign`. */
export const CALLSIGN_MIN = 3;
export const CALLSIGN_MAX = 16;

/**
 * The account, as the client sees it.
 *
 * `email` is present only for the owner's own account and never for anyone else's
 * — see `PublicProfile` for what other players may see. There is no password
 * field here at all, deliberately: the only place a hash is ever read is the auth
 * package's own login comparison, and a field that does not exist cannot be
 * leaked by a careless `res.json(user)`.
 */
export interface Account {
  id: number;
  callsign: string;
  email: string | null;
  /** True while this is a guest. Registering upgrades in place, keeping `id`. */
  anonymous: boolean;
  tier: TierId;
  /** ISO date, or null when the tier does not expire (the free ones). */
  tierExpiresAt: string | null;
  createdAt: string;
}

/** What any player may see about another. A strict subset of `Account`. */
export interface PublicProfile {
  id: number;
  callsign: string;
  tier: TierId;
  career: Career;
  medals: AwardedMedal[];
}

export interface Career {
  matches: number;
  kills: number;
  deaths: number;
  /** Metres. The stat this game is actually about. */
  longestShotMetres: number;
  timePlayedSeconds: number;
}

export const EMPTY_CAREER: Career = {
  matches: 0,
  kills: 0,
  deaths: 0,
  longestShotMetres: 0,
  timePlayedSeconds: 0,
};

export interface AwardedMedal {
  medalId: string;
  awardedAt: string;
}

/**
 * A tier can lapse, so the stored tier is not necessarily the effective one.
 *
 * Resolved here rather than at each call site: a supporter whose subscription
 * ended still has `tier = "supporter"` in the row until something rewrites it,
 * and every capability check has to agree about when that stops counting.
 * Returns the tier to *treat* the account as.
 */
export function effectiveTier(
  tier: TierId,
  tierExpiresAt: string | null,
  now: Date
): TierId {
  if (tierExpiresAt === null) return tier;
  const expires = Date.parse(tierExpiresAt);
  // An unparseable date is treated as expired rather than as forever. Failing
  // closed is the only safe direction for something that grants capabilities.
  if (Number.isNaN(expires) || expires <= now.getTime()) {
    return tier === "supporter" ? "enlisted" : tier;
  }
  return tier;
}

export interface CallsignProblem {
  reason: "too_short" | "too_long" | "charset" | "reserved";
  message: string;
}

/**
 * Reserved prefixes. `Recruit-` is what guests are auto-named, so a registered
 * account taking it could impersonate one; the rest are role impersonation.
 */
const RESERVED_PREFIXES = ["recruit-", "admin", "moderator", "official", "distantfront"];

/**
 * Validate a callsign.
 *
 * Letters, digits, underscore and single interior hyphens only. No spaces and no
 * Unicode: a callsign is read off a HUD at a glance and shouted over voice, and
 * homoglyph impersonation is a real problem in games with clans.
 */
export function validateCallsign(raw: string): CallsignProblem | null {
  const value = raw.trim();
  if (value.length < CALLSIGN_MIN) {
    return { reason: "too_short", message: `At least ${CALLSIGN_MIN} characters.` };
  }
  if (value.length > CALLSIGN_MAX) {
    return { reason: "too_long", message: `At most ${CALLSIGN_MAX} characters.` };
  }
  if (!/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/.test(value)) {
    return {
      reason: "charset",
      message: "Letters, numbers and underscores, with single hyphens between them.",
    };
  }
  const lower = value.toLowerCase();
  if (RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return { reason: "reserved", message: "That name is reserved." };
  }
  return null;
}

/**
 * The guest name. Not random-looking on purpose — a guest should read as a
 * placeholder so that "make an account" is an obvious next step rather than a
 * setting to hunt for.
 */
export function guestCallsign(seed: number): string {
  return `Recruit-${String(Math.abs(Math.trunc(seed)) % 10000).padStart(4, "0")}`;
}
