// Account database: schema, connection and migrations.
//
// SERVER ONLY. Nothing in src/ may import this file — it pulls in a native SQLite
// driver, and the directory boundary is what keeps that out of the browser bundle
// and out of the shared account types. The shapes the client sees live in
// src/account/accountTypes.ts and are deliberately not these row types.
//
// Kysely directly rather than @colyseus/database, which is rejected and argued in
// docs/plans/2026-08-04-web-platform-and-ui-design.md section 2.2.

import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql, type Generated } from "kysely";
import type { TierId } from "../../src/account/tiers.ts";

/**
 * Rows as stored. SQLite has no boolean and no native JSON, so flags are 0/1
 * integers and structured columns are TEXT holding JSON — which is why
 * `src/account/characters.ts` owns coercion rather than trusting the column.
 */
export interface UserRow {
  id: Generated<number>;
  callsign: string;
  /** Null while anonymous. Unique when set. */
  email: string | null;
  /**
   * Scrypt hash, written and compared by @colyseus/auth's own Hash.
   *
   * SECURITY, and it is a real limitation rather than a footnote: that hash uses
   * ONE process-wide salt (`AUTH_SALT`, defaulting to a public literal in the
   * package), not a per-user salt. So two accounts with the same password store
   * the same hash, and the salt is effectively a pepper that must stay secret.
   * `tools/account/authSettings.ts` refuses to boot without a strong AUTH_SALT
   * for exactly this reason. Fixing it properly means replacing the package's
   * /login and /register handlers, because they call Hash.make directly and never
   * consult the onHashPassword setting.
   */
  password: string | null;
  anonymous: number;
  /** The id @colyseus/auth generates for a guest. Unique when set. */
  anonymous_id: string | null;
  discord_id: string | null;
  tier: TierId;
  tier_expires_at: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface CareerRow {
  user_id: number;
  matches: number;
  kills: number;
  deaths: number;
  longest_shot_metres: number;
  time_played_seconds: number;
}

export interface CharacterRow {
  user_id: number;
  /** JSON. Read through coerceCharacter, never trusted as-is. */
  appearance: string;
  loadout: string;
  updated_at: string;
}

export interface MedalRow {
  id: Generated<number>;
  user_id: number;
  medal_id: string;
  awarded_at: string;
}

/**
 * A friendship edge, stored ONCE rather than as two mirrored rows.
 *
 * Two rows per friendship is the shape that eventually disagrees with itself —
 * one side accepted, the other still pending — so "my friends" queries both
 * columns instead. Design record §4.
 */
export interface FriendshipRow {
  id: Generated<number>;
  requester_id: number;
  addressee_id: number;
  state: "pending" | "accepted";
  created_at: string;
  responded_at: string | null;
  /**
   * `pairKey(requester_id, addressee_id)` — the pair, order removed, UNIQUE.
   *
   * The one index that can actually enforce "at most one edge between two
   * people". A unique index on `(requester_id, addressee_id)` cannot: `(A,B)` and
   * `(B,A)` are distinct keys, so two people pressing "add friend" at the same
   * moment both passed the repository's check-then-insert and both rows landed,
   * leaving two pending edges that no accept could fully resolve.
   *
   * The direction columns STAY, and are still the source of truth for who asked —
   * `friendState` needs it to tell pending_out from pending_in. This column
   * carries no information of its own; it exists so the database can refuse.
   */
  pair_key: string;
}

/**
 * The unordered identity of a pair of accounts.
 *
 * Numeric sort, not lexicographic: `"10"` sorts before `"9"` as text, so a string
 * comparison would give `(9,10)` and `(10,9)` two different keys and defeat the
 * whole point of the column.
 */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** SQLite reports a unique constraint failure by message; there is no code. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/** Blocking is NOT a friendship state: someone you never met can need blocking. */
export interface BlockRow {
  blocker_id: number;
  blocked_id: number;
  created_at: string;
}

/** One tagwall note. `body` is plain text and is never rendered as markup. */
export interface ProfilePostRow {
  id: Generated<number>;
  /** Whose wall it is on. */
  profile_id: number;
  author_id: number;
  body: string;
  created_at: string;
}

export interface ClanRow {
  id: Generated<number>;
  /** 2-5 of [A-Z0-9]. The thing that appears beside a name. */
  tag: string;
  name: string;
  founder_id: number;
  created_at: string;
}

export interface ClanMemberRow {
  clan_id: number;
  user_id: number;
  role: "leader" | "officer" | "member";
  joined_at: string;
}

/**
 * One finished session. The EVENT behind the career counters.
 *
 * `career` holds totals, which cannot answer "when". A profile that shows a
 * month of activity needs the events, and inventing them from a counter is the
 * one thing this project never does — so the room writes a row here when a
 * player leaves, alongside the increment it already performs.
 */
export interface SessionRow {
  id: Generated<number>;
  user_id: number;
  ended_at: string;
  seconds: number;
}

/**
 * One player's participation in one match.
 *
 * NOTHING WRITES THIS YET, and unlike `engagements` it is not blocked on
 * ballistics — it is simply unbuilt. Three readers already depend on it
 * (`playerStats`, `StatsRepository.leaderboard`, `StatsRepository.maps`), so until
 * a writer exists every win, loss, draw, stance duration and shot count they
 * report is absent rather than zero, and the derived figures return null instead
 * of a number. `patienceScore` explains what that cost when it did not.
 *
 * A row needs the match identity (the room id and its map), the join and leave
 * times, and the stance/shot counters the room would have to accumulate per
 * player per tick. The first three the room already knows at `onLeave`; the
 * counters are the part that does not exist.
 *
 * Do not write a partial row to "turn the section on": a row with zeroed counters
 * makes `available.objectives` true and every figure above it a false claim.
 */
export interface MatchParticipationRow {
  id: Generated<number>;
  user_id: number;
  match_id: string;
  map: string;
  mode: string;
  team: string | null;
  joined_at: string;
  left_at: string;
  result: "win" | "loss" | "draw" | "unknown";
  score: number;
  objective_score: number;
  support_score: number;
  prone_ms: number;
  crouch_ms: number;
  stand_ms: number;
  moving_ms: number;
  concealed_ms: number;
  shots_fired: number;
  best_streak: number;
}

/**
 * One shot that resolved against a player.
 *
 * `range_metres` is the column Delta Force's own logs could never produce and
 * ours can, and it is the axis this game is about — every range statistic on a
 * profile comes from here. Written by the authority layer on feat/server-
 * ballistics; nothing else may write it, because a client-reported kill is not
 * evidence.
 */
export interface EngagementRow {
  id: Generated<number>;
  match_id: string;
  shooter_id: number;
  target_id: number | null;
  at: string;
  weapon_id: string;
  range_metres: number;
  hit: number;
  fatal: number;
  headshot: number;
  shooter_stance: string;
  /** Stationary time before the trigger. Feeds the patience score. */
  hold_ms: number;
  first_of_engagement: number;
}

export interface ObjectiveEventRow {
  id: Generated<number>;
  match_id: string;
  user_id: number;
  at: string;
  kind: string;
  zone_id: string | null;
  held_ms: number;
}

export interface SchemaVersionRow {
  version: number;
}

export interface AccountDatabase {
  users: UserRow;
  career: CareerRow;
  characters: CharacterRow;
  medals: MedalRow;
  friendships: FriendshipRow;
  blocks: BlockRow;
  profile_posts: ProfilePostRow;
  clans: ClanRow;
  clan_members: ClanMemberRow;
  sessions: SessionRow;
  match_participation: MatchParticipationRow;
  engagements: EngagementRow;
  objective_events: ObjectiveEventRow;
  schema_version: SchemaVersionRow;
}

export type AccountDb = Kysely<AccountDatabase>;

/**
 * Open the database.
 *
 * SQLite only for now, and that is a deliberate stopping point rather than an
 * oversight: Postgres is the intended production store, but adding the `pg`
 * driver for a deployment that does not exist means shipping an untested code
 * path. When there is somewhere to deploy, this function grows a branch on
 * `DATABASE_URL` returning `new PostgresDialect({ pool })`; nothing above it
 * changes, which is the whole reason for using a query builder here.
 *
 * `:memory:` is honoured, which is what the tests use.
 */
export function openDatabase(file: string): AccountDb {
  const sqlite = new Database(file);
  // WAL for concurrent reads while a write is in flight, and foreign keys ON —
  // SQLite ignores REFERENCES entirely without this, so a cascade that looks
  // declared simply would not happen.
  if (file !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<AccountDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
}

/**
 * Ordered migrations. APPEND ONLY, and never edit a shipped entry.
 *
 * Hand-rolled against a `schema_version` counter rather than Kysely's file-based
 * Migrator, because the whole schema is small and a directory scan is one more
 * thing to get wrong at deploy time. This replaces the pattern the Colyseus
 * template uses — `createTable` in a try/catch that swallows every error — which
 * cannot tell "already applied" from "failed", and so silently leaves a database
 * half-migrated.
 */
const MIGRATIONS: ((db: AccountDb) => Promise<void>)[] = [
  async (db) => {
    await db.schema
      .createTable("users")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("callsign", "text", (c) => c.notNull().unique())
      .addColumn("email", "text", (c) => c.unique())
      .addColumn("password", "text")
      .addColumn("anonymous", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("anonymous_id", "text", (c) => c.unique())
      .addColumn("discord_id", "text", (c) => c.unique())
      .addColumn("tier", "text", (c) => c.notNull().defaultTo("enlisted"))
      .addColumn("tier_expires_at", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("last_seen_at", "text", (c) => c.notNull())
      .execute();

    // Login normalises the address before querying, so the lookup is on
    // `lower(email)` and needs its own index — the UNIQUE constraint above does
    // not cover it. Built from the `sql` template rather than a string: Kysely's
    // `expression()` takes an Expression, and a plain string has no
    // `toOperationNode`, which fails at migration time rather than at compile time.
    await db.schema
      .createIndex("users_email_lower")
      .on("users")
      .expression(sql`lower(email)`)
      .execute();

    await db.schema
      .createTable("career")
      .addColumn("user_id", "integer", (c) =>
        c.primaryKey().references("users.id").onDelete("cascade")
      )
      .addColumn("matches", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("kills", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("deaths", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("longest_shot_metres", "real", (c) => c.notNull().defaultTo(0))
      .addColumn("time_played_seconds", "integer", (c) => c.notNull().defaultTo(0))
      .execute();

    await db.schema
      .createTable("characters")
      .addColumn("user_id", "integer", (c) =>
        c.primaryKey().references("users.id").onDelete("cascade")
      )
      .addColumn("appearance", "text", (c) => c.notNull())
      .addColumn("loadout", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("medals")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("user_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("medal_id", "text", (c) => c.notNull())
      .addColumn("awarded_at", "text", (c) => c.notNull())
      .execute();

    // A medal is awarded once. Without this, a re-award on every match end is a
    // profile page that grows the same ribbon forever.
    await db.schema
      .createIndex("medals_unique")
      .on("medals")
      .columns(["user_id", "medal_id"])
      .unique()
      .execute();
  },

  // Leaderboards. Every board is `WHERE <column> > 0 ORDER BY <column> DESC` over
  // the whole career table, and without an index that is a full scan plus a sort
  // on every click of every tab.
  //
  // The column names are written out rather than read from `LEADERBOARD_COLUMNS`
  // on purpose: a migration records what it did on the day it ran, and a step
  // that follows a mutable constant would mean the same version number describes
  // a different schema depending on when it executed.
  async (db) => {
    for (const column of [
      "matches",
      "kills",
      "longest_shot_metres",
      "time_played_seconds",
    ] as const) {
      await db.schema
        .createIndex(`career_${column}`)
        .on("career")
        .column(column)
        .execute();
    }
  },

  // The community layer: profiles are already public, this is everything that
  // makes them a PLACE rather than a readout. All five tables in one step
  // because they share a privacy model and shipping them separately would mean
  // migrating twice. Design record: plans/2026-08-04-community-layer-design.md.
  async (db) => {
    await db.schema
      .createTable("friendships")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("requester_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("addressee_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("responded_at", "text")
      .execute();
    // One edge per pair in one direction. The repository normalises before
    // inserting so a reversed duplicate cannot be created either.
    await db.schema
      .createIndex("friendships_pair")
      .on("friendships")
      .columns(["requester_id", "addressee_id"])
      .unique()
      .execute();
    // "My incoming requests" and "my friends" are the only two reads.
    await db.schema
      .createIndex("friendships_addressee")
      .on("friendships")
      .columns(["addressee_id", "state"])
      .execute();
    await db.schema
      .createIndex("friendships_requester")
      .on("friendships")
      .columns(["requester_id", "state"])
      .execute();

    await db.schema
      .createTable("blocks")
      .addColumn("blocker_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("blocked_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("created_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("blocks_pk", ["blocker_id", "blocked_id"])
      .execute();

    await db.schema
      .createTable("profile_posts")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("profile_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("author_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("body", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    // Reading a wall is newest-first for one profile; the rate limiter reads by
    // author and time. Both are covered here.
    await db.schema
      .createIndex("profile_posts_wall")
      .on("profile_posts")
      .columns(["profile_id", "created_at"])
      .execute();
    await db.schema
      .createIndex("profile_posts_author")
      .on("profile_posts")
      .columns(["author_id", "created_at"])
      .execute();

    await db.schema
      .createTable("clans")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("tag", "text", (c) => c.notNull().unique())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("founder_id", "integer", (c) => c.notNull().references("users.id"))
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    // Tags are compared case-insensitively for the same reason callsigns are.
    await db.schema
      .createIndex("clans_tag_lower")
      .on("clans")
      .expression(sql`lower(tag)`)
      .execute();

    await db.schema
      .createTable("clan_members")
      .addColumn("clan_id", "integer", (c) =>
        c.notNull().references("clans.id").onDelete("cascade")
      )
      .addColumn("user_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("joined_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("clan_members_pk", ["clan_id", "user_id"])
      .execute();
    // ONE clan per player. Not a shortcut: multi-clan membership makes "which
    // tag appears beside this name" ambiguous, and the tag beside the name is
    // the entire visible point of a clan.
    await db.schema
      .createIndex("clan_members_user")
      .on("clan_members")
      .column("user_id")
      .unique()
      .execute();
  },

  // Session events, so a profile can show a month rather than a total. The
  // career counters stay: they are the authoritative totals and re-deriving them
  // from this table on every read would be slower and could disagree after a
  // pruning. This table is the history, not the source of truth.
  async (db) => {
    await db.schema
      .createTable("sessions")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("user_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("ended_at", "text", (c) => c.notNull())
      .addColumn("seconds", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("sessions_user_time")
      .on("sessions")
      .columns(["user_id", "ended_at"])
      .execute();
  },

  // Telemetry. Three tables that every figure on a stats page derives from —
  // nothing here stores a ratio, because a stored ratio goes stale the moment a
  // source row is corrected. Design record:
  // plans/2026-08-04-player-statistics-design.md section 3.
  async (db) => {
    await db.schema
      .createTable("match_participation")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("user_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("match_id", "text", (c) => c.notNull())
      .addColumn("map", "text", (c) => c.notNull())
      .addColumn("mode", "text", (c) => c.notNull())
      .addColumn("team", "text")
      .addColumn("joined_at", "text", (c) => c.notNull())
      .addColumn("left_at", "text", (c) => c.notNull())
      .addColumn("result", "text", (c) => c.notNull().defaultTo("unknown"))
      .addColumn("score", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("objective_score", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("support_score", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("prone_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("crouch_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("stand_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("moving_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("concealed_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("shots_fired", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("best_streak", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
    await db.schema
      .createIndex("participation_user_time")
      .on("match_participation")
      .columns(["user_id", "left_at"])
      .execute();
    await db.schema
      .createIndex("participation_map")
      .on("match_participation")
      .columns(["user_id", "map"])
      .execute();

    await db.schema
      .createTable("engagements")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("match_id", "text", (c) => c.notNull())
      .addColumn("shooter_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("target_id", "integer", (c) => c.references("users.id").onDelete("set null"))
      .addColumn("at", "text", (c) => c.notNull())
      .addColumn("weapon_id", "text", (c) => c.notNull())
      .addColumn("range_metres", "real", (c) => c.notNull())
      .addColumn("hit", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("fatal", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("headshot", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("shooter_stance", "text", (c) => c.notNull().defaultTo("stand"))
      .addColumn("hold_ms", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("first_of_engagement", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
    // The four reads: a shooter's profile, a target's nemeses, a weapon's page
    // and a range histogram. All of them start from shooter or target.
    await db.schema
      .createIndex("engagements_shooter")
      .on("engagements")
      .columns(["shooter_id", "at"])
      .execute();
    await db.schema
      .createIndex("engagements_target")
      .on("engagements")
      .columns(["target_id", "at"])
      .execute();
    await db.schema
      .createIndex("engagements_weapon")
      .on("engagements")
      .column("weapon_id")
      .execute();

    await db.schema
      .createTable("objective_events")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("match_id", "text", (c) => c.notNull())
      .addColumn("user_id", "integer", (c) =>
        c.notNull().references("users.id").onDelete("cascade")
      )
      .addColumn("at", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("zone_id", "text")
      .addColumn("held_ms", "integer", (c) => c.notNull().defaultTo(0))
      .execute();
    await db.schema
      .createIndex("objective_user")
      .on("objective_events")
      .columns(["user_id", "at"])
      .execute();
  },

  // Make "one edge per pair" something the DATABASE enforces.
  //
  // `friendships_pair` was already unique on (requester_id, addressee_id) and its
  // comment claimed the repository normalised the order before inserting. It did
  // not, and the index could not have caught it anyway: (A,B) and (B,A) are two
  // different keys. Two simultaneous opposite requests both passed the
  // check-then-insert and both landed. This adds the order-free key that can.
  //
  // Backfilled in application code rather than in SQL because `min(a,b)` over two
  // arguments is SQLite's spelling and `least(a,b)` is Postgres's — and the whole
  // reason this project uses a query builder is to not write that branch twice.
  async (db) => {
    await db.schema.alterTable("friendships").addColumn("pair_key", "text").execute();
    const existing = await db
      .selectFrom("friendships")
      .select(["id", "requester_id", "addressee_id"])
      .execute();
    for (const row of existing) {
      await db
        .updateTable("friendships")
        .set({ pair_key: pairKey(row.requester_id, row.addressee_id) })
        .where("id", "=", row.id)
        .execute();
    }
    // Any duplicate pair already in the table would fail here, which is the
    // correct outcome: it is exactly the corruption this index exists to stop, and
    // a migration that silently dropped one side of it would be worse.
    await db.schema
      .createIndex("friendships_pair_key")
      .on("friendships")
      .column("pair_key")
      .unique()
      .execute();
  },
];

/**
 * Bring the database up to date, and report what it did.
 *
 * Idempotent: run it on every boot. Each step runs in its own transaction with
 * the version bump, so a failure half way leaves the previous version intact
 * rather than a schema that claims to be newer than it is.
 */
export async function migrate(db: AccountDb): Promise<{ from: number; to: number }> {
  await db.schema
    .createTable("schema_version")
    .ifNotExists()
    .addColumn("version", "integer", (c) => c.notNull())
    .execute();

  const row = await db.selectFrom("schema_version").select("version").executeTakeFirst();
  const from = row?.version ?? 0;

  for (let version = from; version < MIGRATIONS.length; version += 1) {
    const step = MIGRATIONS[version]!;
    await db.transaction().execute(async (tx) => {
      await step(tx);
      if (version === 0) {
        await tx.insertInto("schema_version").values({ version: 1 }).execute();
      } else {
        await tx
          .updateTable("schema_version")
          .set({ version: version + 1 })
          .execute();
      }
    });
  }

  return { from, to: MIGRATIONS.length };
}
