// Brings the account layer up and mounts it on the game server's Express app.
//
// SERVER ONLY, and the single entry point: `tools/game-server/server.ts` calls
// `mountAccounts(app)` and nothing else. Keeping the assembly here rather than in
// server.ts is deliberate — that file is the game's, it is edited by whoever is
// working on the simulation, and the auth layer should not widen its diff.
//
// One process and one deployment, per the design record: the same server that
// simulates the match also serves /auth and /api.

import { auth } from "@colyseus/auth";
import type { Application } from "express";
import { migrate, openDatabase, type AccountDb } from "./database.ts";
import { AccountRepository } from "./repository.ts";
import { configureAuth, configuredProviders } from "./authSettings.ts";
import { createApiRouter } from "./api.ts";
import { createLobbyRouter } from "./lobbyApi.ts";
import { createCommunityRouter } from "./communityApi.ts";
import { CommunityRepository } from "./communityRepository.ts";
import { StatsRepository } from "./statsRepository.ts";
import { createStatsRouter } from "./statsApi.ts";

export interface MountedAccounts {
  db: AccountDb;
  repository: AccountRepository;
  community: CommunityRepository;
  providers: string[];
}

export interface MountOptions {
  /**
   * Which account is in which room, for friends-only presence.
   *
   * Passed IN by the game server rather than read out of it: the rooms own who
   * is playing, and this direction of dependency is what lets the account layer
   * be mounted in a test with no rooms at all.
   */
  presence?: () => ReadonlyMap<number, string>;
}

/**
 * `DF2_DB` — where the SQLite file lives. `:memory:` is honoured and is what the
 * tests use; a path is what a deployment wants, because in-memory means every
 * account disappears on restart.
 */
const DB_FILE = process.env.DF2_DB ?? "./account.db";

/**
 * `DF2_CHECKOUT=1` — a real payment provider is wired.
 *
 * Off by default and mirrors the client's `VITE_CHECKOUT`. Two variables rather
 * than one because the client's is baked at build time and the server's is not,
 * and the server is the one that must never grant a paid tier by accident.
 */
const CHECKOUT_ENABLED = process.env.DF2_CHECKOUT === "1";

/**
 * `DF2_ADMIN=1` — this is a development server somebody is driving.
 *
 * Opens the dev-only tier grant. The same variable the room-wide visual dials
 * already use, because they answer the same question and two switches would
 * eventually disagree on the one box where it matters.
 */
const ADMIN_ENABLED = process.env.DF2_ADMIN === "1";

export async function mountAccounts(
  app: Application,
  options: MountOptions = {}
): Promise<MountedAccounts> {
  const db = openDatabase(DB_FILE);
  const { from, to } = await migrate(db);
  if (from !== to) console.log(`[accounts] migrated schema ${from} -> ${to}`);

  const repository = new AccountRepository(db);
  const community = new CommunityRepository(db);
  const stats = new StatsRepository(db);
  configureAuth({
    repository,
    // No provider in development. onForgotPassword logs the reset link instead,
    // which is a working flow for one machine and an obvious gap in production.
    sendEmail: null,
  });

  const providers = configuredProviders();

  // The package's routes: /auth/login, /register, /anonymous, /userdata,
  // /forgot-password, /reset-password, /confirm-email, plus provider callbacks.
  app.use(auth.prefix, auth.routes());
  app.use(
    "/api",
    createApiRouter({
      repository,
      providers,
      checkoutEnabled: CHECKOUT_ENABLED,
      adminEnabled: ADMIN_ENABLED,
    })
  );
  // Server browser, join codes and leaderboards. A separate router because these
  // read the matchmaker rather than the database.
  app.use("/api", createLobbyRouter({ repository }));
  // Profiles, walls, friends and clans.
  app.use(
    "/api",
    createCommunityRouter({
      accounts: repository,
      community,
      presence: options.presence ?? (() => new Map()),
    })
  );

  // The board, weapons, maps and head-to-head. Public.
  app.use("/api", createStatsRouter({ accounts: repository, community, stats }));

  console.log(
    `[accounts] ${DB_FILE} — auth at ${auth.prefix}, api at /api` +
      (providers.length > 0 ? `, oauth: ${providers.join(", ")}` : ", oauth: none configured") +
      (CHECKOUT_ENABLED ? ", CHECKOUT LIVE" : "") +
      (ADMIN_ENABLED ? ", ADMIN (dev tier grant open)" : "")
  );

  return { db, repository, community, providers };
}
