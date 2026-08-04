// Every account query, in one place.
//
// SERVER ONLY. The auth callbacks and the HTTP API both go through here rather
// than writing SQL of their own, so there is one answer to "what is an account"
// and one place that maps a row to the `Account` shape the client sees. That
// mapping is the security boundary: `UserRow` has a password column and `Account`
// has no such field, so a careless `res.json` cannot leak a hash.

import { sql } from "kysely";
import {
  EMPTY_CAREER,
  guestCallsign,
  validateCallsign,
  type Account,
  type Career,
  type PublicProfile,
} from "../../src/account/accountTypes.ts";
import {
  DEFAULT_CHARACTER,
  coerceCharacter,
  type Character,
} from "../../src/account/characters.ts";
import type { LeaderboardUnit } from "../../src/account/lobby.ts";
import { earnedMedals } from "../../src/account/medals.ts";
import type { TierId } from "../../src/account/tiers.ts";
import type { AccountDb, UserRow } from "./database.ts";

/** A row as selected, with `id` resolved to a number. */
type SelectedUser = {
  [K in keyof UserRow]: UserRow[K] extends { __select__: infer S } ? S : UserRow[K];
};

/**
 * What login needs: enough to verify a password and mint a token, and nothing
 * that should not be echoed back to the client. See `findUserByEmail`.
 */
type LoginCandidate = Omit<
  Pick<
    SelectedUser,
    | "id"
    | "callsign"
    | "email"
    | "password"
    | "anonymous"
    | "tier"
    | "tier_expires_at"
    | "created_at"
  >,
  "password"
> & { password: string };

/**
 * Stands in for "this account has no password" — a Discord or guest account.
 *
 * The auth package's callback type demands a non-null password because its login
 * handler compares `user.password === await Hash.make(attempt)`. Null would be a
 * type error; omitting the row entirely would be worse, because the same query
 * backs the "is this email already in use" check, and a passwordless account
 * would then be invisible to it and the UNIQUE constraint would surface as a 500.
 *
 * Empty string is safe as the sentinel: `Hash.make` returns 128 hex characters for
 * every input including the empty one, so it can never equal this, and a
 * password login against a Discord-only account correctly fails.
 */
const NO_PASSWORD = "";

/**
 * Career columns a leaderboard may rank by.
 *
 * A closed union rather than a string, because the value is interpolated into an
 * ORDER BY and a column reference. Nothing from a request reaches this type
 * without passing through `LEADERBOARD_COLUMNS` first.
 */
export type LeaderboardColumn =
  | "matches"
  | "kills"
  | "longest_shot_metres"
  | "time_played_seconds";

/**
 * Everything a board is: which column it ranks, what to call it, how its numbers
 * read, and whether anything writes them yet.
 *
 * All four in one row because they are four facts about the same board, and the
 * two that were not here — the unit and `populated` — had grown into open-coded
 * conditionals in the route and a third one in the page, which agreed with this
 * table only by somebody remembering to update all three.
 */
export interface LeaderboardDefinition {
  column: LeaderboardColumn;
  label: string;
  unit: LeaderboardUnit;
  /** False while nothing writes the column. The page says which kind of empty. */
  populated: boolean;
}

/** Board id (what the URL says) to its definition. */
export const LEADERBOARD_COLUMNS: Record<string, LeaderboardDefinition> = {
  matches: { column: "matches", label: "Matches played", unit: "count", populated: true },
  // Kills and longest shot wait on server-authoritative damage; `recordLongestShot`
  // exists and is tested but nothing calls it yet.
  kills: { column: "kills", label: "Kills", unit: "count", populated: false },
  distance: {
    column: "longest_shot_metres",
    label: "Longest shot",
    unit: "metres",
    populated: false,
  },
  time: {
    column: "time_played_seconds",
    label: "Time played",
    unit: "seconds",
    populated: true,
  },
};

const nowIso = (): string => new Date().toISOString();

/**
 * Row to client shape. The ONLY place this conversion happens.
 *
 * Note what is absent: `password`, `anonymous_id` and `discord_id` never cross
 * this line. They are storage details, and two of them are credentials.
 */
export function toAccount(row: SelectedUser): Account {
  return {
    id: row.id,
    callsign: row.callsign,
    email: row.email,
    anonymous: row.anonymous === 1,
    tier: row.tier,
    tierExpiresAt: row.tier_expires_at,
    createdAt: row.created_at,
  };
}

export class AccountRepository {
  // An explicit field, not a constructor parameter property: Node runs this file
  // with --experimental-strip-types, and strip-only mode rejects
  // `constructor(private readonly db)` outright.
  private readonly db: AccountDb;

  constructor(db: AccountDb) {
    this.db = db;
  }

  /**
   * Used by @colyseus/auth's login handler, which compares
   * `user.password === Hash.make(attempt)`. So this MUST return the hash — it is
   * the one query that does, and it is why nothing else selects `password`.
   *
   * Case-insensitive: people do not remember whether they capitalised their
   * email, and "no such account" for a correct password is the worst error a
   * sign-in form can give.
   */
  async findUserByEmail(email: string): Promise<LoginCandidate | undefined> {
    // NARROWED on purpose. The auth package returns whatever this resolves to
    // straight back to the client from /auth/login and /auth/register (after
    // deleting `password`), so every column selected here becomes a response
    // field. `anonymous_id` and `discord_id` are internal identifiers with no
    // business on the wire, so they are not selected.
    const row = await this.db
      .selectFrom("users")
      .select([
        "id",
        "callsign",
        "email",
        "password",
        "anonymous",
        "tier",
        "tier_expires_at",
        "created_at",
      ])
      .where(sql`lower(email)`, "=", email.trim().toLowerCase())
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return { ...row, password: row.password ?? NO_PASSWORD };
  }

  async findById(id: number): Promise<SelectedUser | undefined> {
    return await this.db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async findByCallsign(callsign: string): Promise<SelectedUser | undefined> {
    return await this.db
      .selectFrom("users")
      .selectAll()
      .where(sql`lower(callsign)`, "=", callsign.trim().toLowerCase())
      .executeTakeFirst();
  }

  /**
   * Create a guest.
   *
   * The callsign is generated and retried on collision rather than derived from
   * the row id: `Recruit-0001`, `Recruit-0002` would be unique with no retry at
   * all, but it also publishes how many accounts exist and makes the next guest
   * name predictable.
   */
  async createGuest(anonymousId: string): Promise<Account> {
    const created = nowIso();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // Widen the space on later attempts instead of looping forever on a
      // saturated 4-digit range.
      const seed = attempt < 6 ? Math.floor(Math.random() * 10000) : Math.floor(Math.random() * 1e9);
      const callsign = guestCallsign(seed);
      if ((await this.findByCallsign(callsign)) !== undefined) continue;
      try {
        const row = await this.db
          .insertInto("users")
          .values({
            callsign,
            email: null,
            password: null,
            anonymous: 1,
            anonymous_id: anonymousId,
            discord_id: null,
            tier: "guest",
            tier_expires_at: null,
            created_at: created,
            last_seen_at: created,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.ensureRelated(row.id);
        return toAccount(row);
      } catch (error) {
        // Another connection took the name between the check and the insert.
        // Retry; anything else is a real failure and must not be swallowed.
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("could not allocate a guest callsign");
  }

  /**
   * Register with email and password, or UPGRADE the guest identified by
   * `upgradingId` in place.
   *
   * Upgrading in place is the whole point of the funnel: the account keeps its id,
   * so its career, medals and saved character survive. Creating a new row and
   * copying would leave the guest's own id valid and its progress duplicated.
   */
  async registerWithEmailAndPassword(input: {
    email: string;
    passwordHash: string;
    callsign?: string;
    upgradingId?: number;
  }): Promise<Account> {
    const email = input.email.trim().toLowerCase();
    const callsign = input.callsign?.trim();
    if (callsign !== undefined && callsign !== "") {
      const problem = validateCallsign(callsign);
      if (problem !== null) throw new Error(problem.message);
      const taken = await this.findByCallsign(callsign);
      if (taken !== undefined && taken.id !== input.upgradingId) {
        throw new Error("callsign_taken");
      }
    }

    if (input.upgradingId !== undefined) {
      const existing = await this.findById(input.upgradingId);
      // Refuse to "upgrade" anything that is not still a guest. A replayed token
      // must not be able to overwrite a real account's email and password.
      if (existing === undefined || existing.anonymous !== 1) {
        throw new Error("not_upgradable");
      }
      const row = await this.db
        .updateTable("users")
        .set({
          email,
          password: input.passwordHash,
          anonymous: 0,
          anonymous_id: null,
          tier: "enlisted",
          ...(callsign !== undefined && callsign !== "" ? { callsign } : {}),
          last_seen_at: nowIso(),
        })
        .where("id", "=", input.upgradingId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.ensureRelated(row.id);
      return toAccount(row);
    }

    const created = nowIso();
    const row = await this.db
      .insertInto("users")
      .values({
        callsign: callsign !== undefined && callsign !== "" ? callsign : await this.callsignFromEmail(email),
        email,
        password: input.passwordHash,
        anonymous: 0,
        anonymous_id: null,
        discord_id: null,
        tier: "enlisted",
        tier_expires_at: null,
        created_at: created,
        last_seen_at: created,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.ensureRelated(row.id);
    return toAccount(row);
  }

  /** Create or update the account behind a Discord identity. */
  async upsertDiscord(profile: {
    id: string;
    username: string;
    email?: string | null;
  }): Promise<Account> {
    const existing = await this.db
      .selectFrom("users")
      .selectAll()
      .where("discord_id", "=", profile.id)
      .executeTakeFirst();
    if (existing !== undefined) {
      const row = await this.db
        .updateTable("users")
        .set({ last_seen_at: nowIso() })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAccount(row);
    }
    const created = nowIso();
    const row = await this.db
      .insertInto("users")
      .values({
        callsign: await this.uniqueCallsign(profile.username),
        email: profile.email?.trim().toLowerCase() ?? null,
        password: null,
        anonymous: 0,
        anonymous_id: null,
        discord_id: profile.id,
        tier: "enlisted",
        tier_expires_at: null,
        created_at: created,
        last_seen_at: created,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.ensureRelated(row.id);
    return toAccount(row);
  }

  async setPasswordByEmail(email: string, passwordHash: string): Promise<void> {
    await this.db
      .updateTable("users")
      .set({ password: passwordHash })
      .where(sql`lower(email)`, "=", email.trim().toLowerCase())
      .execute();
  }

  async setCallsign(userId: number, callsign: string): Promise<void> {
    const problem = validateCallsign(callsign);
    if (problem !== null) throw new Error(problem.message);
    const taken = await this.findByCallsign(callsign);
    if (taken !== undefined && taken.id !== userId) throw new Error("callsign_taken");
    await this.db
      .updateTable("users")
      .set({ callsign: callsign.trim() })
      .where("id", "=", userId)
      .execute();
  }

  /**
   * Set an account's tier and when it lapses.
   *
   * The ONLY writer of an entitlement. `expiresAt` is stored as given and read
   * back through `effectiveTier`, which fails closed on an unparseable date — so
   * a bad value downgrades the account rather than granting forever.
   *
   * Nothing here touches medals: those come only from play (design record §6),
   * and keeping the two writers separate is what makes that structural rather
   * than a convention somebody has to remember.
   */
  async setTier(userId: number, tier: TierId, expiresAt: string | null): Promise<void> {
    await this.db
      .updateTable("users")
      .set({ tier, tier_expires_at: expiresAt })
      .where("id", "=", userId)
      .execute();
  }

  async touch(userId: number): Promise<void> {
    await this.db
      .updateTable("users")
      .set({ last_seen_at: nowIso() })
      .where("id", "=", userId)
      .execute();
  }

  async career(userId: number): Promise<Career> {
    const row = await this.db
      .selectFrom("career")
      .selectAll()
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (row === undefined) return { ...EMPTY_CAREER };
    return {
      matches: row.matches,
      kills: row.kills,
      deaths: row.deaths,
      longestShotMetres: row.longest_shot_metres,
      timePlayedSeconds: row.time_played_seconds,
    };
  }

  async medals(userId: number): Promise<{ medalId: string; awardedAt: string }[]> {
    const rows = await this.db
      .selectFrom("medals")
      .select(["medal_id", "awarded_at"])
      .where("user_id", "=", userId)
      .orderBy("awarded_at", "desc")
      .execute();
    return rows.map((row) => ({ medalId: row.medal_id, awardedAt: row.awarded_at }));
  }

  /**
   * Award every medal this account's career now qualifies for, and report the
   * ones that were not already held.
   *
   * Evaluated from the stored career rather than from the session that just
   * ended, so a medal is a statement about the record and not about one match —
   * and so a missed award (a crash between writing the session and awarding)
   * corrects itself the next time anyone plays.
   *
   * The existing ids are read first rather than relying on the unique index
   * alone, because "which are new" is what the caller wants to announce, and
   * ON CONFLICT DO NOTHING cannot tell you that.
   */
  async syncMedals(userId: number): Promise<string[]> {
    const career = await this.career(userId);
    const earned = earnedMedals(career);
    if (earned.length === 0) return [];
    const held = new Set((await this.medals(userId)).map((medal) => medal.medalId));
    const fresh = earned.filter((id) => !held.has(id));
    if (fresh.length === 0) return [];
    const awarded = nowIso();
    await this.db
      .insertInto("medals")
      .values(fresh.map((id) => ({ user_id: userId, medal_id: id, awarded_at: awarded })))
      // Belt and braces against two sessions ending at once: the unique index is
      // the real guarantee, and without this the race surfaces as a 500.
      .onConflict((oc) => oc.columns(["user_id", "medal_id"]).doNothing())
      .execute();
    return fresh;
  }

  async publicProfile(userId: number): Promise<PublicProfile | null> {
    const row = await this.findById(userId);
    if (row === undefined) return null;
    // Together, not in sequence: neither read depends on the other, and only the
    // existence check above had to come first.
    const [career, medals] = await Promise.all([this.career(userId), this.medals(userId)]);
    return { id: row.id, callsign: row.callsign, tier: row.tier, career, medals };
  }

  async character(userId: number): Promise<Character> {
    const row = await this.db
      .selectFrom("characters")
      .selectAll()
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (row === undefined) return structuredClone(DEFAULT_CHARACTER);
    // Coerced, never trusted: the columns are TEXT holding JSON written by an
    // older build, and a profile page that throws on an old row is worse than one
    // showing a default sleeve.
    return coerceCharacter({
      appearance: safeParse(row.appearance),
      loadout: safeParse(row.loadout),
    });
  }

  async saveCharacter(userId: number, character: Character): Promise<void> {
    const updated = nowIso();
    await this.db
      .insertInto("characters")
      .values({
        user_id: userId,
        appearance: JSON.stringify(character.appearance),
        loadout: JSON.stringify(character.loadout),
        updated_at: updated,
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          appearance: JSON.stringify(character.appearance),
          loadout: JSON.stringify(character.loadout),
          updated_at: updated,
        })
      )
      .execute();
  }

  /**
   * Record the end of a session: one more match, and the seconds played.
   *
   * Called by the game room when a player leaves, which is what makes the
   * leaderboard real rather than a table of zeros. Kills and deaths are NOT
   * touched here — they need the server-authoritative damage work on
   * feat/server-ballistics, and inventing them from client reports would be worse
   * than leaving them at zero.
   *
   * An incrementing UPDATE rather than read-modify-write: the same account can end
   * two sessions at once (one on a phone, one on a desktop), and a read-then-write
   * would lose one of them.
   */
  async recordSession(userId: number, secondsPlayed: number): Promise<void> {
    const seconds = Math.max(0, Math.round(secondsPlayed));
    await this.db
      .updateTable("career")
      .set((eb) => ({
        matches: eb("matches", "+", 1),
        time_played_seconds: eb("time_played_seconds", "+", seconds),
      }))
      .where("user_id", "=", userId)
      .execute();
  }

  /**
   * Raise the longest-shot record, never lower it.
   *
   * Separate from `recordSession` because it is a MAXIMUM rather than a sum, and
   * because the shot that sets it happens mid-match. The `where` does the
   * comparison, so a slower report arriving late cannot overwrite a better one.
   */
  async recordLongestShot(userId: number, metres: number): Promise<void> {
    if (!Number.isFinite(metres) || metres <= 0) return;
    await this.db
      .updateTable("career")
      .set({ longest_shot_metres: metres })
      .where("user_id", "=", userId)
      .where("longest_shot_metres", "<", metres)
      .execute();
  }

  /**
   * Leaderboard rows for one stat.
   *
   * Guests are EXCLUDED. A guest account is per-browser and disposable, so
   * ranking them would fill the board with names nobody can be held to and would
   * reward clearing your storage. Being ranked is a reason to register.
   *
   * Ties break on callsign so the order is stable between requests — without a
   * second key, two accounts on the same score swap places at random and the board
   * looks like it is churning.
   */
  async leaderboard(
    column: LeaderboardColumn,
    limit: number
  ): Promise<{ rank: number; id: number; callsign: string; tier: TierId; value: number }[]> {
    const rows = await this.db
      .selectFrom("career")
      .innerJoin("users", "users.id", "career.user_id")
      .select(["users.id", "users.callsign", "users.tier"])
      .select((eb) => eb.ref(`career.${column}`).as("value"))
      .where("users.anonymous", "=", 0)
      .where((eb) => eb(eb.ref(`career.${column}`), ">", 0))
      .orderBy(`career.${column}`, "desc")
      .orderBy("users.callsign", "asc")
      .limit(Math.max(1, Math.min(100, limit)))
      .execute();
    return rows.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      callsign: row.callsign,
      tier: row.tier,
      value: Number(row.value),
    }));
  }

  /** Career and character rows every account is expected to have. */
  private async ensureRelated(userId: number): Promise<void> {
    await this.db
      .insertInto("career")
      .values({ user_id: userId, ...toCareerRow(EMPTY_CAREER) })
      .onConflict((oc) => oc.column("user_id").doNothing())
      .execute();
  }

  /** `ada@example.com` becomes `ada`, made unique. */
  private async callsignFromEmail(email: string): Promise<string> {
    const local = email.split("@")[0] ?? "operator";
    return await this.uniqueCallsign(local);
  }

  /**
   * A callsign near `base` that nobody holds.
   *
   * Sanitises first, because an email local part or a Discord username can
   * contain dots and Unicode that `validateCallsign` rejects — and a registration
   * that fails on a name the user never typed is baffling.
   */
  private async uniqueCallsign(base: string): Promise<string> {
    const cleaned = base.replace(/[^A-Za-z0-9_]/g, "").slice(0, 12) || "Operator";
    const padded = cleaned.length >= 3 ? cleaned : `${cleaned}Ops`;
    if ((await this.findByCallsign(padded)) === undefined && validateCallsign(padded) === null) {
      return padded;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = `${padded.slice(0, 12)}-${Math.floor(Math.random() * 1000)}`;
      if (validateCallsign(candidate) !== null) continue;
      if ((await this.findByCallsign(candidate)) === undefined) return candidate;
    }
    throw new Error("could not allocate a callsign");
  }
}

function toCareerRow(career: Career) {
  return {
    matches: career.matches,
    kills: career.kills,
    deaths: career.deaths,
    longest_shot_metres: career.longestShotMetres,
    time_played_seconds: career.timePlayedSeconds,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** SQLite reports a unique constraint failure by message; there is no code. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
