// The medal catalogue, and the award path against a real database.
//
// Two things are worth pinning here and neither is visible from the table alone:
// that an unearnable medal cannot be awarded even when its own test would pass,
// which is what `earnable` exists for, and that awarding twice does not stack —
// a profile that grows the same ribbon after every match is the failure the
// unique index and the diff in `syncMedals` between them are there to prevent.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { migrate, openDatabase, type AccountDb } from "../../tools/account/database.ts";
import { AccountRepository } from "../../tools/account/repository.ts";
import { EMPTY_CAREER, type Career } from "../../src/account/accountTypes.ts";
import { MEDALS, earnedMedals, medalById } from "../../src/account/medals.ts";

let db: AccountDb;
let repo: AccountRepository;

before(async () => {
  db = openDatabase(":memory:");
  await migrate(db);
  repo = new AccountRepository(db);
});

after(async () => {
  await db.destroy();
});

const career = (patch: Partial<Career>): Career => ({ ...EMPTY_CAREER, ...patch });

describe("the catalogue", () => {
  it("has unique ids and no empty text", () => {
    const ids = MEDALS.map((medal) => medal.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate medal id");
    for (const medal of MEDALS) {
      assert.ok(medal.name.length > 0, medal.id);
      assert.ok(medal.description.length > 0, medal.id);
      // The requirement is what makes a locked medal worth chasing rather than
      // just a greyed-out row.
      assert.ok(medal.requirement.length > 0, medal.id);
    }
  });

  it("looks up by id and reports nothing for an unknown one", () => {
    assert.equal(medalById("first-deployment")?.name, "First Deployment");
    assert.equal(medalById("no-such-medal"), undefined);
  });
});

describe("earning", () => {
  it("awards nothing for an empty career", () => {
    assert.deepEqual(earnedMedals(EMPTY_CAREER), []);
  });

  it("awards the service medals a career has actually reached", () => {
    assert.deepEqual(earnedMedals(career({ matches: 1 })), ["first-deployment"]);
    assert.deepEqual(earnedMedals(career({ matches: 10 })), [
      "first-deployment",
      "veteran-10",
    ]);
    // 3599 seconds is not an hour. Thresholds are >=, and an off-by-one here
    // would award an hour medal to someone 59 minutes in.
    assert.deepEqual(earnedMedals(career({ timePlayedSeconds: 3599 })), []);
    assert.deepEqual(earnedMedals(career({ timePlayedSeconds: 3600 })), ["hours-1"]);
  });

  it("refuses to award a combat medal even when its own test passes", () => {
    // The whole point of `earnable`: kills and longest shot are not written by
    // anything yet, so a number appearing in those columns is not evidence. This
    // assertion is what stops the flag being decorative.
    const combat = career({ kills: 500, longestShotMetres: 2000 });
    const awarded = earnedMedals(combat);
    assert.equal(awarded.includes("first-blood"), false);
    assert.equal(awarded.includes("centurion"), false);
    assert.equal(awarded.includes("marksman-1000"), false);
    // ...while their own predicates would have said yes.
    for (const id of ["first-blood", "centurion", "marksman-1000"] as const) {
      assert.equal(medalById(id)?.qualifies(combat), true, id);
    }
  });
});

describe("syncMedals", () => {
  it("awards, then stays put on a second call", async () => {
    const account = await repo.registerWithEmailAndPassword({
      email: "medals@example.com",
      passwordHash: "x".repeat(128),
      callsign: "MedalTest",
    });
    await repo.recordSession(account.id, 30);

    const first = await repo.syncMedals(account.id);
    assert.deepEqual(first, ["first-deployment"]);
    assert.deepEqual(
      (await repo.medals(account.id)).map((medal) => medal.medalId),
      ["first-deployment"]
    );

    // The same career again must award nothing new and must not duplicate the
    // row — this runs after every single match, so it is the hot path.
    const second = await repo.syncMedals(account.id);
    assert.deepEqual(second, []);
    assert.equal((await repo.medals(account.id)).length, 1);
  });

  it("awards only what is newly crossed as the career grows", async () => {
    const account = await repo.registerWithEmailAndPassword({
      email: "growth@example.com",
      passwordHash: "x".repeat(128),
      callsign: "GrowthTest",
    });
    // One match, then eight more: the tenth is what earns Ten Deep, and the
    // already-held first-deployment must not be reported as fresh again.
    // Sessions are 60 s because a session under 30 s is not a match — see below.
    await repo.recordSession(account.id, 60);
    assert.deepEqual(await repo.syncMedals(account.id), ["first-deployment"]);
    for (let i = 0; i < 9; i += 1) await repo.recordSession(account.id, 60);
    assert.deepEqual(await repo.syncMedals(account.id), ["veteran-10"]);
  });

  it("cannot be farmed by a join/leave loop", async () => {
    const account = await repo.registerWithEmailAndPassword({
      email: "loop@example.com",
      passwordHash: "x".repeat(128),
      callsign: "LoopTest",
    });
    // MEASURED before the floor existed: 60 zero-length sessions credited 60
    // matches and awarded first-deployment, veteran-10 and veteran-50 — three of
    // the five earnable medals, and the top of the only board anything writes,
    // from a script that just connected and disconnected.
    for (let i = 0; i < 60; i += 1) await repo.recordSession(account.id, 0);
    const career = await repo.career(account.id);
    assert.equal(career.matches, 0, "a zero-length session is not a match played");
    assert.deepEqual(await repo.syncMedals(account.id), []);

    // Time played is still credited in full: it is a truthful sum either way, and
    // the cap in the game server bounds the parked-socket case.
    await repo.recordSession(account.id, 20);
    assert.equal((await repo.career(account.id)).timePlayedSeconds, 20);
    assert.equal((await repo.career(account.id)).matches, 0);

    // And a real match still counts.
    await repo.recordSession(account.id, 30);
    assert.equal((await repo.career(account.id)).matches, 1);
    assert.deepEqual(await repo.syncMedals(account.id), ["first-deployment"]);
  });
});

describe("tiers", () => {
  it("are written by setTier and read back on the account", async () => {
    const account = await repo.registerWithEmailAndPassword({
      email: "tier@example.com",
      passwordHash: "x".repeat(128),
      callsign: "TierTest",
    });
    assert.equal(account.tier, "enlisted");

    const expires = new Date(Date.now() + 86400000).toISOString();
    await repo.setTier(account.id, "supporter", expires);
    const row = await repo.findById(account.id);
    assert.equal(row?.tier, "supporter");
    assert.equal(row?.tier_expires_at, expires);

    // Granting a tier must not touch medals — the two writers are separate on
    // purpose, because a bought medal is the thing the model forbids.
    assert.deepEqual(await repo.medals(account.id), []);
  });
});
