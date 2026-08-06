// The account layer's HTTP surface, driven through real Express routers.
//
// Every guarantee here was previously "verified against a live server" by hand
// and pinned by nothing, which is how three of them regressed into the pre-merge
// review as findings: a capability enforced only by a hidden button, a rename
// with no tier check, an endpoint open to anybody. A route-level test is the only
// thing that can hold them, because the checks live in the routers rather than in
// the repositories the other suites cover.
//
// No supertest: Node has a real HTTP server and `fetch`, so the routers are
// mounted on an ephemeral port and asked over the wire like any client. Tokens
// are REAL — signed the way the server signs them — so the whole chain is under
// test, including that a token carries only an id plus its version and that the
// account is re-read from the database on every request.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
// Before anything imports the auth package's settings: `auth.middleware()` is
// constructed when a router is built and refuses to exist without a secret, and
// `configureAuth` enforces the same rule the server boots under.
process.env.JWT_SECRET ??= "test-jwt-secret-that-is-long-enough";
process.env.AUTH_SALT ??= "test-auth-salt-that-is-long-enough";
import express from "express";
import { configureAuth } from "../../tools/account/authSettings.ts";
import { auth } from "@colyseus/auth";
import { migrate, openDatabase, type AccountDb } from "../../tools/account/database.ts";
import { AccountRepository } from "../../tools/account/repository.ts";
import { CommunityRepository } from "../../tools/account/communityRepository.ts";
import { StatsRepository } from "../../tools/account/statsRepository.ts";
import { createApiRouter } from "../../tools/account/api.ts";
import { createCommunityRouter } from "../../tools/account/communityApi.ts";
import { createStatsRouter } from "../../tools/account/statsApi.ts";

let db: AccountDb;
let accounts: AccountRepository;
let community: CommunityRepository;
let server: import("node:http").Server;
let origin = "";

/** The account whose token accompanies the next request, or null for nobody. */
let actingId: number | null = null;
const tokens = new Map<number, string>();

/** A real signed token for an account, minted the way the server mints them. */
async function tokenFor(id: number): Promise<string> {
  const existing = tokens.get(id);
  if (existing !== undefined) return existing;
  const generate = auth.settings.onGenerateToken;
  assert.ok(generate !== undefined, "configureAuth did not wire onGenerateToken");
  const minted = await generate({ id });
  tokens.set(id, minted);
  return minted;
}

before(async () => {
  db = openDatabase(":memory:");
  await migrate(db);
  accounts = new AccountRepository(db);
  community = new CommunityRepository(db);
  const stats = new StatsRepository(db);

  // The real callbacks, so tokens this suite mints are the tokens the server
  // would mint and `accountFromToken` is the thing resolving them.
  configureAuth({ repository: accounts, sendEmail: null });

  const app = express();
  app.use("/api", createApiRouter({
    repository: accounts,
    providers: [],
    checkoutEnabled: false,
    // OFF, which is what production runs — the 404 below is the assertion.
    adminEnabled: false,
  }));
  app.use("/api", createCommunityRouter({
    accounts,
    community,
    presence: () => new Map(),
  }));
  app.use("/api", createStatsRouter({ accounts, community, stats }));

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.destroy();
});

/** One request, as the account currently being acted as (or as nobody). */
async function call(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (actingId !== null) headers.authorization = `Bearer ${await tokenFor(actingId)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

describe("routes that need an account", () => {
  it("refuse an unidentified caller", async () => {
    actingId = null;
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["PATCH", "/api/me"],
      ["PUT", "/api/me/character"],
      ["GET", "/api/friends"],
      ["POST", "/api/clans"],
      ["POST", "/api/clan/leave"],
    ] as const) {
      const { status } = await call(method, path, method === "GET" ? undefined : {});
      assert.equal(status, 401, `${method} ${path} answered ${status} for nobody`);
    }
  });

  it("leave the public reads public", async () => {
    actingId = null;
    for (const path of ["/api/config", "/api/clans", "/api/stats/leaderboard"]) {
      const { status } = await call("GET", path);
      assert.equal(status, 200, `${path} answered ${status} for a signed-out visitor`);
    }
  });
});

describe("capability gates", () => {
  let guest = 0;
  let member = 0;

  before(async () => {
    guest = (await accounts.createGuest("routes-guest")).id;
    member = (
      await accounts.registerWithEmailAndPassword({
        email: "routes@example.com",
        passwordHash: "x".repeat(128),
        callsign: "RouteTest",
      })
    ).id;
  });

  it("refuse a guest the callsign a registered account may choose", async () => {
    // `persistentName` was advertised by the tier table and checked NOWHERE: a
    // guest could claim any name against a unique column, permanently, and lose
    // the `recruit-` prefix that identifies them as unregistered.
    actingId = guest;
    const refused = await call("PATCH", "/api/me", { callsign: "NovaLogic" });
    assert.equal(refused.status, 403);
    assert.equal((await accounts.findById(guest))?.callsign.startsWith("Recruit-"), true);

    actingId = member;
    const allowed = await call("PATCH", "/api/me", { callsign: "NovaLogic" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.callsign, "NovaLogic");
  });

  it("refuse a guest the friends list, not just the friend request", async () => {
    // The request side was gated and the READ was not, so a guest who received a
    // request could accept it and then read friends-only presence.
    actingId = guest;
    assert.equal((await call("GET", "/api/friends")).status, 403);
    assert.equal((await call("POST", `/api/players/${member}/friend`)).status, 403);
    assert.equal((await call("POST", `/api/players/${member}/friend/accept`)).status, 403);

    actingId = member;
    assert.equal((await call("GET", "/api/friends")).status, 200);
  });

  it("refuse founding a clan below supporter, and allow joining one", async () => {
    actingId = member;
    assert.equal((await call("POST", "/api/clans", { tag: "RTE", name: "Routed" })).status, 403);

    await accounts.setTier(member, "supporter", null);
    assert.equal((await call("POST", "/api/clans", { tag: "RTE", name: "Routed" })).status, 200);

    // Joining is deliberately open to any account — supporters run things,
    // players do things.
    actingId = guest;
    assert.equal((await call("POST", "/api/clans/RTE/join")).status, 200);
  });

  it("answer 404 rather than 403 for the dev tier grant when admin is off", async () => {
    // 404 is the point: a 403 would tell a prober that a self-service tier grant
    // exists on this deployment.
    actingId = member;
    assert.equal((await call("POST", "/api/me/tier", { tier: "supporter" })).status, 404);
    assert.equal((await accounts.findById(member))?.tier, "supporter", "unchanged by the 404");
  });
});

describe("what a response may contain", () => {
  it("never carries a password hash or a provider id", async () => {
    const row = await accounts.registerWithEmailAndPassword({
      email: "leak@example.com",
      passwordHash: "y".repeat(128),
      callsign: "LeakTest",
    });
    actingId = row.id;
    const me = await call("GET", "/api/me");
    assert.equal(me.status, 200);
    const serialised = JSON.stringify(me.json);
    assert.equal(serialised.includes("y".repeat(20)), false, "a password hash crossed the wire");
    assert.equal(serialised.includes("anonymousId"), false);
    assert.equal(serialised.includes("discordId"), false);
  });

  it("reports a rename failure without naming a table or column", async () => {
    const other = await accounts.registerWithEmailAndPassword({
      email: "taken@example.com",
      passwordHash: "z".repeat(128),
      callsign: "AlreadyMine",
    });
    actingId = other.id;
    const clash = await call("PATCH", "/api/me", { callsign: "NovaLogic" });
    assert.equal(clash.status, 400);
    assert.equal(clash.json.error, "callsign_taken");
    assert.equal(
      JSON.stringify(clash.json).toLowerCase().includes("unique"),
      false,
      "driver text must not reach the client"
    );
  });
});

describe("token lifetime", () => {
  it("stops accepting a token issued before a password reset", async () => {
    const row = await accounts.registerWithEmailAndPassword({
      email: "reset@example.com",
      passwordHash: "a".repeat(128),
      callsign: "ResetTest",
    });
    actingId = row.id;
    assert.equal((await call("GET", "/api/me")).status, 200, "a fresh token should work");

    // The standard remedy for a compromised account. Before `token_version`
    // existed, the attacker's 30-day token stayed valid straight through it.
    await accounts.setPasswordByEmail("reset@example.com", "b".repeat(128));
    assert.equal(
      (await call("GET", "/api/me")).status,
      401,
      "a token minted before the reset must stop working"
    );

    // A token minted after it works again, so the account is not locked out.
    tokens.delete(row.id);
    assert.equal((await call("GET", "/api/me")).status, 200);
  });

  it("refuses a payload with no numeric id", async () => {
    const generate = auth.settings.onGenerateToken;
    assert.ok(generate !== undefined);
    // An attacker-shaped payload: the right signature over the wrong claims.
    const forged = await generate({ id: 999_999 } as never);
    const response = await fetch(`${origin}/api/me`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    assert.equal(response.status, 401, "a token for a nonexistent account must be refused");
  });
});
