// The two pure functions on the auth trust boundary.
//
// `requireSecrets` is what stops the server booting with @colyseus/auth's
// published default salt, and `accountFromToken` is what a verified token means —
// shared by the package's own middleware, the HTTP API and the room's `onAuth`,
// so loosening it would go unnoticed in three places at once. Neither had a test.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { migrate, openDatabase, type AccountDb } from "../../tools/account/database.ts";
import { AccountRepository } from "../../tools/account/repository.ts";
import { accountFromToken, requireSecrets } from "../../tools/account/authSettings.ts";

let db: AccountDb;
let accounts: AccountRepository;
let accountId = 0;

before(async () => {
  db = openDatabase(":memory:");
  await migrate(db);
  accounts = new AccountRepository(db);
  accountId = (
    await accounts.registerWithEmailAndPassword({
      email: "auth@example.com",
      passwordHash: "x".repeat(128),
      callsign: "AuthTest",
    })
  ).id;
});

after(async () => {
  await db.destroy();
});

/** Run `body` with the environment replaced, then put it back exactly as it was. */
function withEnv(patch: Record<string, string | undefined>, body: () => void): void {
  const saved = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const LONG = "0123456789012345678901234567890";

describe("requireSecrets", () => {
  it("refuses to start without either secret, and names both", () => {
    withEnv({ JWT_SECRET: undefined, AUTH_SALT: undefined }, () => {
      assert.throws(requireSecrets, /JWT_SECRET and AUTH_SALT/);
    });
    withEnv({ JWT_SECRET: LONG, AUTH_SALT: undefined }, () => {
      assert.throws(requireSecrets, /AUTH_SALT/);
    });
    withEnv({ JWT_SECRET: undefined, AUTH_SALT: LONG }, () => {
      assert.throws(requireSecrets, /JWT_SECRET/);
    });
  });

  it("refuses a JWT secret too short to be one", () => {
    // A short secret is worse than a missing one: it looks configured.
    withEnv({ JWT_SECRET: "short", AUTH_SALT: LONG }, () => {
      assert.throws(requireSecrets, /too short/);
    });
  });

  it("demands SESSION_SECRET only when a provider is configured", () => {
    // The OAuth router builds an express-session with it; unset, EVERY provider
    // request 500s with nothing pointing at the cause. Without a provider
    // configured the variable is irrelevant and must not block a boot.
    withEnv(
      { JWT_SECRET: LONG, AUTH_SALT: LONG, SESSION_SECRET: undefined },
      () => {
        assert.doesNotThrow(requireSecrets);
      }
    );
    withEnv(
      {
        JWT_SECRET: LONG,
        AUTH_SALT: LONG,
        SESSION_SECRET: undefined,
        DISCORD_CLIENT_ID: "id",
        DISCORD_CLIENT_SECRET: "secret",
      },
      () => {
        assert.throws(requireSecrets, /SESSION_SECRET/);
      }
    );
  });
});

describe("accountFromToken", () => {
  it("resolves a live account from the id in the payload", async () => {
    const account = await accountFromToken(accounts, { id: accountId, v: 0 });
    assert.equal(account?.id, accountId);
    assert.equal(account?.callsign, "AuthTest");
  });

  it("refuses anything that is not a numeric id", async () => {
    // A payload is attacker-shaped data even when the signature is valid: the
    // package verifies WHO signed it, not what they put in it.
    for (const payload of [
      null,
      undefined,
      {},
      { id: "1" },
      { id: "1 OR 1=1" },
      { id: null },
      { id: { toString: () => "1" } },
      [accountId],
    ]) {
      assert.equal(await accountFromToken(accounts, payload), null, JSON.stringify(payload));
    }
  });

  it("refuses a deleted account rather than trusting the payload", async () => {
    assert.equal(await accountFromToken(accounts, { id: 999_999, v: 0 }), null);
  });

  it("refuses a token minted before a password reset", async () => {
    assert.notEqual(await accountFromToken(accounts, { id: accountId, v: 0 }), null);
    await accounts.setPasswordByEmail("auth@example.com", "y".repeat(128));
    assert.equal(
      await accountFromToken(accounts, { id: accountId, v: 0 }),
      null,
      "the old version must stop resolving"
    );
    assert.notEqual(await accountFromToken(accounts, { id: accountId, v: 1 }), null);
  });

  it("accepts a versionless token, so the migration logs nobody out", async () => {
    // Tokens signed before the column existed carry no `v`. Those resolve
    // against version 0 — which this account is no longer on, so use a fresh one.
    const fresh = await accounts.registerWithEmailAndPassword({
      email: "versionless@example.com",
      passwordHash: "z".repeat(128),
      callsign: "Versionless",
    });
    assert.notEqual(await accountFromToken(accounts, { id: fresh.id }), null);
  });
});
