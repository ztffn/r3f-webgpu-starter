// Join codes, room options and leaderboard queries.
//
// The join code is the only thing protecting a private match, so its alphabet and
// its source of randomness both get asserted. Room options come from an untrusted
// client, so the assertion that matters is that nothing passes through unclamped.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeJoinCode, readRoomOptions } from "../../tools/account/roomMetadata.ts";
import { normaliseJoinCode } from "../../src/account/lobby.ts";
import { LEADERBOARD_COLUMNS, leaderboardDefinition } from "../../tools/account/repository.ts";
import { migrate, openDatabase, type AccountDb } from "../../tools/account/database.ts";
import { AccountRepository } from "../../tools/account/repository.ts";

describe("join codes", () => {
  it("avoid every character pair that gets misheard or mistyped", () => {
    // Codes are read aloud over voice and typed from memory. O/0, I/1/L, S/5,
    // B/8 and Z/2 are each a support request waiting to happen.
    const forbidden = /[OIL0125BSZ]/;
    for (let i = 0; i < 400; i += 1) {
      const code = makeJoinCode();
      assert.equal(code.length, 6, code);
      assert.ok(!forbidden.test(code), `${code} contains an ambiguous character`);
      assert.match(code, /^[A-Z0-9]{6}$/, code);
    }
  });

  it("do not repeat over a large sample", () => {
    // Not a randomness proof, but a collision here would mean the generator is
    // seeded per call or the alphabet collapsed.
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(makeJoinCode());
    assert.ok(seen.size > 1990, `only ${seen.size} distinct codes in 2000`);
  });

  it("normalise what a human types", () => {
    assert.equal(normaliseJoinCode(" a4c-7fh "), "A4C7FH");
    assert.equal(normaliseJoinCode("A4C 7FH"), "A4C7FH");
    assert.equal(normaliseJoinCode(""), "");
  });
});

describe("readRoomOptions", () => {
  it("defaults to a public desktop room with no label", () => {
    assert.deepEqual(readRoomOptions(undefined), {
      isPrivate: false,
      inputClass: "desktop",
      label: null,
    });
    assert.deepEqual(readRoomOptions({}), {
      isPrivate: false,
      inputClass: "desktop",
      label: null,
    });
  });

  it("only treats the exact string 'private' as private", () => {
    assert.equal(readRoomOptions({ visibility: "private" }).isPrivate, true);
    // Anything else is public. Failing open on VISIBILITY is the safe direction:
    // a room wrongly public is findable, a room wrongly private is unreachable.
    for (const value of ["Private", "PRIVATE", true, 1, "yes", null]) {
      assert.equal(readRoomOptions({ visibility: value }).isPrivate, false, String(value));
    }
  });

  it("only accepts the two known input classes", () => {
    assert.equal(readRoomOptions({ inputClass: "touch" }).inputClass, "touch");
    for (const value of ["desktop", "gamepad", "", 7, null, undefined]) {
      assert.equal(readRoomOptions({ inputClass: value }).inputClass, "desktop", String(value));
    }
  });

  it("strips control characters from a label and caps its length", () => {
    // The label renders in every other player's server browser, so it is the one
    // piece of free text a stranger can put on your screen.
    assert.equal(readRoomOptions({ label: "  Ridge  " }).label, "Ridge");
    assert.equal(readRoomOptions({ label: "a\u0000b\u001bc" }).label, "abc");
    assert.equal(readRoomOptions({ label: "x".repeat(80) }).label!.length, 32);
    assert.equal(readRoomOptions({ label: "   " }).label, null);
    assert.equal(readRoomOptions({ label: 42 }).label, null);
  });
});

describe("leaderboards", () => {
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

  it("maps every board id to a real career column and RANKS by it", async () => {
    // The board id comes from the URL and the column is interpolated into the
    // query, so this table is the only thing standing between the two. Asserting
    // `Array.isArray` could not fail once the query succeeded, which let two ids
    // point at the same column, or a column return the wrong figures, unnoticed.
    //
    // Its OWN database: the accounts below would otherwise appear in the sibling
    // tests' boards, which share one connection per describe block.
    const ownDb = openDatabase(":memory:");
    await migrate(ownDb);
    const repo = new AccountRepository(ownDb);
    const first = await repo.registerWithEmailAndPassword({
      email: "board-first@example.com",
      passwordHash: "x".repeat(128),
      callsign: "BoardFirst",
    });
    const second = await repo.registerWithEmailAndPassword({
      email: "board-second@example.com",
      passwordHash: "x".repeat(128),
      callsign: "BoardSecond",
    });
    // `second` leads every board: more matches, more time, a longer shot.
    for (let i = 0; i < 3; i += 1) await repo.recordSession(second.id, 600);
    await repo.recordSession(first.id, 60);
    await repo.recordLongestShot(second.id, 900);
    await repo.recordLongestShot(first.id, 100);

    const columns = new Set<string>();
    for (const [id, entry] of Object.entries(LEADERBOARD_COLUMNS)) {
      columns.add(entry.column);
      const rows = await repo.leaderboard(entry.column, 5);
      // Kills and deaths have no writer yet, so those boards are legitimately
      // empty — the ones fed by `recordSession` and `recordLongestShot` are the
      // ones whose ordering can be checked.
      if (rows.length === 0) continue;
      assert.equal(
        rows[0]?.callsign,
        "BoardSecond",
        `${id} did not rank by ${entry.column} — the leader is wrong`
      );
      const values = rows.map((row) => row.value);
      assert.deepEqual(
        values,
        [...values].sort((a, b) => b - a),
        `${id} came back unsorted`
      );
    }
    assert.equal(
      columns.size,
      Object.keys(LEADERBOARD_COLUMNS).length,
      "two board ids point at the same column, so one of them is mislabelled"
    );
    await ownDb.destroy();
  });

  it("does not resolve inherited object properties to a board", () => {
    // The lookup key is a URL segment and the table is a plain object literal, so
    // a bare index answered `Object.prototype` for `__proto__` and a function for
    // `constructor` and `toString`. All three are non-undefined, so they passed
    // the "no such board" check and reached the query as `career.undefined` — a
    // 500 where a 404 was meant.
    for (const probe of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      assert.equal(leaderboardDefinition(probe), undefined, probe);
    }
    // And a real one still resolves.
    assert.equal(leaderboardDefinition("matches")?.column, "matches");
  });

  it("ranks by value and excludes guests", async () => {
    const guest = await repo.createGuest("board-guest");
    const a = await repo.registerWithEmailAndPassword({
      email: "a@example.com",
      passwordHash: "h",
      callsign: "Alpha",
    });
    const b = await repo.registerWithEmailAndPassword({
      email: "b@example.com",
      passwordHash: "h",
      callsign: "Bravo",
    });
    await repo.recordSession(guest.id, 600);
    await repo.recordSession(a.id, 60);
    await repo.recordSession(b.id, 60);
    await repo.recordSession(b.id, 60);

    const rows = await repo.leaderboard("matches", 10);
    assert.deepEqual(
      rows.map((row) => row.callsign),
      ["Bravo", "Alpha"],
      "two matches should outrank one, and the guest should not appear"
    );
    assert.deepEqual(
      rows.map((row) => row.rank),
      [1, 2]
    );
    assert.ok(!rows.some((row) => row.id === guest.id), "a guest reached the board");
  });

  it("accumulates sessions rather than overwriting them", async () => {
    const account = await repo.registerWithEmailAndPassword({
      email: "acc@example.com",
      passwordHash: "h",
      callsign: "Accumulate",
    });
    await repo.recordSession(account.id, 30);
    await repo.recordSession(account.id, 45);
    const career = await repo.career(account.id);
    assert.equal(career.matches, 2);
    assert.equal(career.timePlayedSeconds, 75);
  });

  it("raises the longest shot but never lowers it", async () => {
    const account = await repo.registerWithEmailAndPassword({
      email: "shot@example.com",
      passwordHash: "h",
      callsign: "Marksman",
    });
    await repo.recordLongestShot(account.id, 420);
    await repo.recordLongestShot(account.id, 180);
    assert.equal((await repo.career(account.id)).longestShotMetres, 420);
    await repo.recordLongestShot(account.id, 900);
    assert.equal((await repo.career(account.id)).longestShotMetres, 900);
    // Junk must not clear a real record.
    await repo.recordLongestShot(account.id, Number.NaN);
    await repo.recordLongestShot(account.id, -5);
    assert.equal((await repo.career(account.id)).longestShotMetres, 900);
  });

  it("omits accounts with a zero score rather than listing them last", async () => {
    const quiet = await repo.registerWithEmailAndPassword({
      email: "quiet@example.com",
      passwordHash: "h",
      callsign: "Quiet",
    });
    const rows = await repo.leaderboard("matches", 50);
    assert.ok(!rows.some((row) => row.id === quiet.id), "a zero score should not be ranked");
  });
});
