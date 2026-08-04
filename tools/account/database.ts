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

export interface SchemaVersionRow {
  version: number;
}

export interface AccountDatabase {
  users: UserRow;
  career: CareerRow;
  characters: CharacterRow;
  medals: MedalRow;
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
