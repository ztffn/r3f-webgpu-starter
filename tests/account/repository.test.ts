// The account repository, against a real in-memory database.
//
// These run the actual SQL, because the things worth checking here are the ones a
// unit test with a fake cannot see: that the guest upgrade keeps the same row so
// progress survives, that a replayed upgrade token cannot overwrite a registered
// account, and that the login query does not select columns the auth package would
// echo back to the client.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { migrate, openDatabase, type AccountDb } from "../../tools/account/database.ts";
import { AccountRepository } from "../../tools/account/repository.ts";
import { DEFAULT_CHARACTER } from "../../src/account/characters.ts";
import { validateCallsign } from "../../src/account/accountTypes.ts";

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

describe("migrations", () => {
  it("are idempotent", async () => {
    // Run on every boot, so a second run must be a no-op rather than an error —
    // this is what the Colyseus template's try/catch could not distinguish.
    const again = await migrate(db);
    assert.equal(again.from, again.to);
  });
});

describe("guests", () => {
  it("get a reserved-shape callsign, the guest tier and a career row", async () => {
    const guest = await repo.createGuest("anon-1");
    assert.match(guest.callsign, /^Recruit-\d{4}$/);
    assert.equal(guest.anonymous, true);
    assert.equal(guest.tier, "guest");
    assert.equal(guest.email, null);
    // A career row exists from the start, so the profile page never has to
    // special-case "no career yet".
    assert.deepEqual(await repo.career(guest.id), {
      matches: 0,
      kills: 0,
      deaths: 0,
      longestShotMetres: 0,
      timePlayedSeconds: 0,
    });
  });

  it("never collide, over enough guests to exhaust a few names", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const guest = await repo.createGuest(`bulk-${i}`);
      assert.ok(!seen.has(guest.callsign), `duplicate ${guest.callsign}`);
      seen.add(guest.callsign);
    }
  });

  it("start on the default character", async () => {
    const guest = await repo.createGuest("anon-default");
    assert.deepEqual(await repo.character(guest.id), DEFAULT_CHARACTER);
  });
});

describe("registering", () => {
  it("UPGRADES a guest in place, so progress survives", async () => {
    const guest = await repo.createGuest("anon-upgrade");
    // Something to lose: a saved appearance and a career worth keeping.
    await repo.saveCharacter(guest.id, {
      appearance: { faction: "opfor", camo: "winter", headgear: "helmet", insignia: null },
      loadout: DEFAULT_CHARACTER.loadout,
    });

    const account = await repo.registerWithEmailAndPassword({
      email: "Upgrade@Example.com",
      passwordHash: "hash",
      callsign: "Upgraded_One",
      upgradingId: guest.id,
    });

    // THE point of the funnel: same row.
    assert.equal(account.id, guest.id);
    assert.equal(account.anonymous, false);
    assert.equal(account.tier, "enlisted");
    assert.equal(account.email, "upgrade@example.com", "email is normalised to lower case");
    assert.equal(account.callsign, "Upgraded_One");
    const character = await repo.character(account.id);
    assert.equal(character.appearance.camo, "winter", "the guest's camo survived");
  });

  it("refuses to upgrade an account that is no longer a guest", async () => {
    // A replayed token must not be able to overwrite a real account's
    // credentials. This is the assertion that makes the upgrade path safe.
    const guest = await repo.createGuest("anon-replay");
    await repo.registerWithEmailAndPassword({
      email: "first@example.com",
      passwordHash: "hash-1",
      upgradingId: guest.id,
    });
    await assert.rejects(
      () =>
        repo.registerWithEmailAndPassword({
          email: "attacker@example.com",
          passwordHash: "hash-2",
          upgradingId: guest.id,
        }),
      /not_upgradable/
    );
    const still = await repo.findById(guest.id);
    assert.equal(still?.email, "first@example.com", "the original email is intact");
  });

  it("refuses an upgrade token for an account that does not exist", async () => {
    await assert.rejects(
      () =>
        repo.registerWithEmailAndPassword({
          email: "ghost@example.com",
          passwordHash: "hash",
          upgradingId: 999999,
        }),
      /not_upgradable/
    );
  });

  it("creates a fresh account with no upgrade token", async () => {
    const account = await repo.registerWithEmailAndPassword({
      email: "fresh@example.com",
      passwordHash: "hash",
    });
    assert.equal(account.anonymous, false);
    assert.equal(account.tier, "enlisted");
    // Callsign derived from the email local part, since none was supplied.
    assert.equal(account.callsign, "fresh");
  });

  it("sanitises a derived callsign that the validator would reject", async () => {
    // `ada.lovelace+dev@` would fail validateCallsign, and a registration that
    // fails on a name the user never typed is baffling.
    const account = await repo.registerWithEmailAndPassword({
      email: "ada.lovelace+dev@example.com",
      passwordHash: "hash",
    });
    assert.match(account.callsign, /^[A-Za-z0-9_]+(-\d+)?$/);
  });

  it("rejects a callsign already held by someone else", async () => {
    await repo.registerWithEmailAndPassword({
      email: "holder@example.com",
      passwordHash: "hash",
      callsign: "Contested",
    });
    await assert.rejects(
      () =>
        repo.registerWithEmailAndPassword({
          email: "other@example.com",
          passwordHash: "hash",
          callsign: "contested",
        }),
      /callsign_taken/,
      "uniqueness is case-insensitive"
    );
  });

  it("rejects a reserved callsign", async () => {
    await assert.rejects(
      () =>
        repo.registerWithEmailAndPassword({
          email: "sneaky@example.com",
          passwordHash: "hash",
          callsign: "Recruit-0001",
        }),
      /reserved/
    );
  });

  it("still registers an address whose local part is a reserved word", async () => {
    // A callsign the user never typed must not be able to refuse them an account.
    // Deriving one from `admin@` produced `admin`, then `admin-1` … `admin-19`,
    // every one of which is reserved by its prefix — twenty-one refusals and a
    // thrown error, so nobody at `admin`, `administrator`, `moderator`,
    // `official` or `distantfront` could register at all.
    for (const local of ["admin", "administrator", "moderator", "official", "distantfront"]) {
      const account = await repo.registerWithEmailAndPassword({
        email: `${local}@example.com`,
        passwordHash: "hash",
      });
      assert.equal(
        validateCallsign(account.callsign),
        null,
        `${local} produced an invalid callsign: ${account.callsign}`
      );
    }
  });
});

describe("findUserByEmail", () => {
  it("is case-insensitive and returns the hash login needs", async () => {
    await repo.registerWithEmailAndPassword({
      email: "case@example.com",
      passwordHash: "the-hash",
    });
    const found = await repo.findUserByEmail("CASE@EXAMPLE.COM");
    assert.equal(found?.password, "the-hash");
  });

  it("does not select the internal identifiers", async () => {
    // The auth package returns this row straight to the client from /auth/login
    // and /auth/register, so every selected column is a response field.
    const found = await repo.findUserByEmail("case@example.com");
    assert.ok(found !== undefined);
    assert.ok(!("anonymous_id" in found), "anonymous_id must not be on the wire");
    assert.ok(!("discord_id" in found), "discord_id must not be on the wire");
  });

  it("reports a passwordless account with a hash nothing can match", async () => {
    // A Discord-only account has no password. It must still be FINDABLE, so the
    // "email already in use" check works, while password login against it fails.
    const discord = await repo.upsertDiscord({
      id: "discord-1",
      username: "ada",
      email: "discord@example.com",
    });
    const found = await repo.findUserByEmail("discord@example.com");
    assert.equal(found?.id, discord.id);
    assert.equal(found?.password, "", "the no-password sentinel");
  });
});

describe("discord", () => {
  it("upserts rather than duplicating on a second sign-in", async () => {
    const first = await repo.upsertDiscord({ id: "discord-2", username: "viper" });
    const second = await repo.upsertDiscord({ id: "discord-2", username: "viper" });
    assert.equal(first.id, second.id);
  });

  it("sanitises a username that would not pass callsign rules", async () => {
    const account = await repo.upsertDiscord({ id: "discord-3", username: "ünï.çode!" });
    assert.match(account.callsign, /^[A-Za-z0-9_]+(-\d+)?$/);
  });
});

describe("toAccount", () => {
  it("never exposes a password, however the row was loaded", async () => {
    // The mapping is the security boundary; this asserts the boundary holds.
    const account = await repo.registerWithEmailAndPassword({
      email: "leak@example.com",
      passwordHash: "secret-hash",
    });
    assert.ok(!("password" in account));
    const profile = await repo.publicProfile(account.id);
    assert.ok(profile !== null && !("password" in profile) && !("email" in profile));
  });
});
