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

export interface MountedAccounts {
  db: AccountDb;
  repository: AccountRepository;
  providers: string[];
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

export async function mountAccounts(app: Application): Promise<MountedAccounts> {
  const db = openDatabase(DB_FILE);
  const { from, to } = await migrate(db);
  if (from !== to) console.log(`[accounts] migrated schema ${from} -> ${to}`);

  const repository = new AccountRepository(db);
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
  app.use("/api", createApiRouter({ repository, providers, checkoutEnabled: CHECKOUT_ENABLED }));

  console.log(
    `[accounts] ${DB_FILE} — auth at ${auth.prefix}, api at /api` +
      (providers.length > 0 ? `, oauth: ${providers.join(", ")}` : ", oauth: none configured") +
      (CHECKOUT_ENABLED ? ", CHECKOUT LIVE" : "")
  );

  return { db, repository, providers };
}
