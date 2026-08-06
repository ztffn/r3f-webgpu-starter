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
import type { Application, NextFunction, Request, Response } from "express";
import { migrate, openDatabase, type AccountDb } from "./database.ts";
import { AccountRepository } from "./repository.ts";
import { configureAuth, configuredProviders } from "./authSettings.ts";
import { createApiRouter } from "./api.ts";
import { createLobbyRouter } from "./lobbyApi.ts";
import { createCommunityRouter } from "./communityApi.ts";
import { CommunityRepository } from "./communityRepository.ts";
import { StatsRepository } from "./statsRepository.ts";
import { createStatsRouter } from "./statsApi.ts";
import { AUTH_LIMITS, callerKey, RateLimiter, type RateLimitRule } from "./rateLimit.ts";

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

  // The credential surface is rate limited BEFORE the package's routes see it.
  // Without this, /auth/login is unlimited password guessing against a hash with
  // one process-wide pepper, /auth/anonymous is unlimited row creation, and the
  // recovery routes are an email-existence oracle anyone can enumerate.
  app.use(auth.prefix, credentialLimiter());
  // And forgot-password answers the same either way — see the shim.
  app.use(auth.prefix, silenceForgotPasswordEnumeration());

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

  // LAST, after every router: Express picks the error handler by arity, and it
  // only runs for what is mounted before it. Without one, an unhandled rejection
  // out of any route hands the client Express's default page — which includes
  // the stack trace, because `npm run game:server` sets no NODE_ENV.
  app.use(errorHandler);

  console.log(
    `[accounts] ${DB_FILE} — auth at ${auth.prefix}, api at /api` +
      (providers.length > 0 ? `, oauth: ${providers.join(", ")}` : ", oauth: none configured") +
      (CHECKOUT_ENABLED ? ", CHECKOUT LIVE" : "") +
      (ADMIN_ENABLED ? ", ADMIN (dev tier grant open)" : "")
  );

  return { db, repository, community, providers };
}

/**
 * Per-IP limits on the credential routes, keyed by which route was asked for.
 *
 * A middleware over the whole `/auth` prefix rather than per-route wiring,
 * because the package owns those routes and we never see their definitions —
 * matching on the path is the only seam available.
 */
function credentialLimiter() {
  const limiter = new RateLimiter();
  return (req: Request, res: Response, next: NextFunction): void => {
    const rule = ruleForAuthPath(req.path);
    if (rule === null) {
      next();
      return;
    }
    const key = `${callerKey(req)}:${req.path}`;
    if (!limiter.check(key, rule)) {
      res
        .status(429)
        .set("Retry-After", String(limiter.retryAfterSeconds(key)))
        .json({ error: "too_many_requests" });
      return;
    }
    next();
  };
}

/**
 * Make `/auth/forgot-password` answer identically for known and unknown emails.
 *
 * @colyseus/auth throws `email_not_found` and answers 401 for an address it has
 * no row for, while succeeding for one it does — so anyone can test whether an
 * address has an account here. The package owns the route and checks before any
 * callback we supply, so the only seam is the RESPONSE: normalise that one
 * refusal into the success shape. Rate limiting (above) bounds the remaining
 * timing signal, and registration still reports `email_already_in_use` because
 * a signup form has to say why it refused.
 */
function silenceForgotPasswordEnumeration() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.toLowerCase().includes("forgot-password")) {
      next();
      return;
    }
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const leaked =
        res.statusCode === 401 &&
        typeof body === "object" &&
        body !== null &&
        (body as { error?: unknown }).error === "email_not_found";
      if (leaked) {
        res.status(200);
        return json(true);
      }
      return json(body);
    };
    next();
  };
}

function ruleForAuthPath(path: string): RateLimitRule | null {
  const route = path.toLowerCase();
  if (route.includes("login")) return AUTH_LIMITS.login;
  if (route.includes("anonymous")) return AUTH_LIMITS.anonymous;
  if (route.includes("register")) return AUTH_LIMITS.register;
  if (route.includes("password")) return AUTH_LIMITS.recovery;
  return null;
}

/**
 * One error shape for the whole account layer: a generic message and a log.
 *
 * Internal text never crosses the wire — a UNIQUE-constraint string names a
 * table and a column, and a stack names paths — but it must still reach the
 * operator, so the log keeps everything the response drops.
 */
function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error("[accounts] unhandled route error:", error);
  res.status(500).json({ error: "server_error" });
}
