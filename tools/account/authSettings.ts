// Wires @colyseus/auth's callbacks onto the account repository.
//
// SERVER ONLY. This is the whole contract with the auth package: it owns the
// routes, the reset-token flow and the OAuth dance, and everything it needs to
// know about accounts arrives through these seven callbacks.
//
// Read `requireSecrets` first. Two environment variables are mandatory and the
// process refuses to start without them, because the defaults are not "less
// secure" — they are publicly known.

import crypto from "node:crypto";
import { JWT, auth } from "@colyseus/auth";
import type { Account } from "../../src/account/accountTypes.ts";
import type { AccountRepository } from "./repository.ts";
import { toAccount } from "./repository.ts";

/**
 * How long a signed token lasts.
 *
 * The package sets no expiry at all by default, which means a leaked token is
 * valid forever. 30 days is the trade: long enough that a GUEST does not lose an
 * account they have no password to log back into, short enough to bound the
 * damage. Shortening it is safe for registered accounts and hostile to guests.
 */
const TOKEN_TTL = "30d";

export interface AuthDeps {
  repository: AccountRepository;
  /**
   * Deliver an email, or null to log the link instead.
   *
   * Null is the development default and it is deliberately loud: password reset
   * that silently does nothing is indistinguishable from a broken account.
   */
  sendEmail: ((to: string, subject: string, html: string) => Promise<void>) | null;
}

/**
 * Fail fast on missing secrets, and say exactly why each one matters.
 *
 * `JWT_SECRET` unset makes every session token forgeable. `AUTH_SALT` unset
 * leaves @colyseus/auth hashing passwords with the literal `"## SALT ##"` baked
 * into the published package — so every deployment that forgets it shares one
 * public salt, and precomputing hashes against it is trivial.
 *
 * The salt is also process-wide rather than per-user, which is a real limitation
 * of the package and is NOT fixed by setting this variable: two accounts with the
 * same password still store the same hash. See the note on `UserRow.password`.
 */
export function requireSecrets(): void {
  const missing: string[] = [];
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
  if (!process.env.AUTH_SALT) missing.push("AUTH_SALT");
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start: ${missing.join(" and ")} must be set.\n` +
        `  JWT_SECRET signs session tokens; unset, anyone can forge one.\n` +
        `  AUTH_SALT salts password hashes; unset, @colyseus/auth uses a salt\n` +
        `  that is published in the package source.\n` +
        `Generate both with: node -e "console.log(crypto.randomUUID())"`
    );
  }
  if ((process.env.JWT_SECRET ?? "").length < 24) {
    throw new Error("Refusing to start: JWT_SECRET is too short to be a secret (need 24+ chars).");
  }
}

/**
 * Which OAuth providers are configured.
 *
 * Providers are added only when their credentials exist, which is a security
 * measure and not just tidiness: @colyseus/auth's OAuth support pulls in `grant`,
 * whose dependency tree carries advisories with no upgrade available
 * (`elliptic`, `uuid` — see the design record). Not registering a provider means
 * those routes are never mounted, so the code is present on disk and unreachable.
 */
export function configuredProviders(): string[] {
  const providers: string[] = [];
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    providers.push("discord");
  }
  return providers;
}

export function configureAuth({ repository, sendEmail }: AuthDeps): void {
  requireSecrets();

  /**
   * Sign only the account id.
   *
   * The package's default signs the whole user object, which puts an email
   * address into every request header and grows the token with the row. An id is
   * enough because `onParseToken` reloads from the database — which also means a
   * tier change or a rename takes effect on the next request instead of on the
   * next login.
   */
  auth.settings.onGenerateToken = async (userdata: unknown) => {
    const id = (userdata as { id?: number }).id;
    if (typeof id !== "number") throw new Error("cannot sign a token without an account id");
    return await JWT.sign({ id }, { expiresIn: TOKEN_TTL });
  };

  auth.settings.onParseToken = async (payload: unknown) => {
    const account = await accountFromToken(repository, payload);
    if (account === null) throw new Error("account_not_found");
    return account;
  };

  auth.settings.onFindUserByEmail = async (email: string) => {
    // Returns the row INCLUDING the password hash, which the package's login
    // handler compares against. The only query that does.
    return await repository.findUserByEmail(email);
  };

  auth.settings.onRegisterWithEmailAndPassword = async (
    email: string,
    passwordHash: string,
    options: { callsign?: unknown; upgradingToken?: unknown }
  ) => {
    // `upgradingToken` is the VERIFIED payload of the caller's current token,
    // decoded by the package before we see it. Its presence is what turns a
    // registration into a guest upgrade, which is how a player keeps the medals
    // and career they earned before making an account.
    const upgradingId = (options.upgradingToken as { id?: number } | undefined)?.id;
    const callsign = typeof options.callsign === "string" ? options.callsign : undefined;
    return await repository.registerWithEmailAndPassword({
      email,
      passwordHash,
      callsign,
      upgradingId: typeof upgradingId === "number" ? upgradingId : undefined,
    });
  };

  auth.settings.onRegisterAnonymously = async () => {
    // Our own identifier rather than the package's, so the column has a known
    // shape. Nothing is read from the request: a guest supplies no data.
    return await repository.createGuest(crypto.randomUUID());
  };

  auth.settings.onForgotPassword = async (email: string, html: string, resetLink: string) => {
    if (sendEmail === null) {
      // Logged, not swallowed. In development this IS the delivery mechanism, and
      // saying so beats a form that reports success and does nothing.
      console.log(`[auth] password reset for ${email} (no email provider):\n  ${resetLink}`);
      return true;
    }
    await sendEmail(email, "Distant Front — reset your password", html);
    return true;
  };

  auth.settings.onResetPassword = async (email: string, passwordHash: string) => {
    await repository.setPasswordByEmail(email, passwordHash);
  };

  const providers = configuredProviders();
  if (providers.includes("discord")) {
    auth.oauth.addProvider("discord", {
      key: process.env.DISCORD_CLIENT_ID!,
      secret: process.env.DISCORD_CLIENT_SECRET!,
      scope: ["identify", "email"],
    });
    auth.oauth.onCallback(async (data: { profile?: Record<string, unknown> }) => {
      const profile = data.profile ?? {};
      const id = profile.id;
      if (typeof id !== "string") throw new Error("discord profile had no id");
      return await repository.upsertDiscord({
        id,
        username:
          (typeof profile.global_name === "string" && profile.global_name) ||
          (typeof profile.username === "string" && profile.username) ||
          "Operator",
        email: typeof profile.email === "string" ? profile.email : null,
      });
    });
  }
}

/**
 * Resolve a verified token payload to a live account, or null.
 *
 * Shared by `onParseToken`, the HTTP API and the game room's `onAuth`, so all
 * three agree on what a token means — including that a deleted account's token
 * stops working immediately rather than at expiry.
 */
export async function accountFromToken(
  repository: AccountRepository,
  payload: unknown
): Promise<Account | null> {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "number") return null;
  const row = await repository.findById(id);
  if (row === undefined) return null;
  return toAccount(row);
}
