// The community layer against a real database.
//
// What is worth pinning here is everything a screen cannot show: that a block
// beats a friend request in both directions, that two people pressing "add
// friend" at the same moment end up friends rather than deadlocked on two
// pending edges, that the per-wall rate limit bites before the global one, and
// that a clan leader cannot walk out and orphan a tag.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { migrate, openDatabase, pairKey, type AccountDb } from "../../tools/account/database.ts";
import { AccountRepository } from "../../tools/account/repository.ts";
import {
  CommunityRepository,
  CommunityError,
} from "../../tools/account/communityRepository.ts";
import {
  POSTS_PER_WALL_PER_HOUR,
  normalisePost,
  validateClanName,
  validateClanTag,
  validatePost,
} from "../../src/account/community.ts";

let db: AccountDb;
let accounts: AccountRepository;
let community: CommunityRepository;

let alice = 0;
let bob = 0;
let carol = 0;
/** A fourth account, so the pair-key test does not disturb the friendships above. */
let dave = 0;

before(async () => {
  db = openDatabase(":memory:");
  await migrate(db);
  accounts = new AccountRepository(db);
  community = new CommunityRepository(db);
  const make = async (name: string) =>
    (
      await accounts.registerWithEmailAndPassword({
        email: `${name}@example.com`,
        passwordHash: "x".repeat(128),
        callsign: name,
      })
    ).id;
  alice = await make("Alice");
  bob = await make("Bob");
  carol = await make("Carol");
  dave = await make("Dave");
});

after(async () => {
  await db.destroy();
});

describe("post validation", () => {
  it("rejects empty, whitespace-only and overlong bodies", () => {
    assert.notEqual(validatePost(""), null);
    assert.notEqual(validatePost("   \n  "), null);
    assert.notEqual(validatePost("x".repeat(281)), null);
    assert.equal(validatePost("Good shooting."), null);
  });

  it("strips control characters but keeps newlines", () => {
    // A wall renders plain text; a stray control character is either invisible
    // or a rendering bug waiting to happen.
    assert.equal(normalisePost("a\u0000b\u200bc"), "abc");
    assert.equal(normalisePost("one\n\n\n\n\ntwo"), "one\n\ntwo");
  });
});

describe("the tagwall", () => {
  it("accepts a note and shows it newest first", async () => {
    await community.post(alice, bob, "First.");
    await community.post(alice, carol, "Second.");
    const wall = await community.wall(alice);
    assert.equal(wall.length, 2);
    assert.equal(wall[0]?.body, "Second.");
    assert.equal(wall[0]?.authorCallsign, "Carol");
  });

  it("lets the wall's owner delete anything, and an author their own", async () => {
    const post = await community.post(alice, bob, "Delete me.");
    // Carol owns neither the wall nor the note.
    await assert.rejects(() => community.deletePost(post.id, carol), /not_yours/);
    // The wall's owner may, without asking anyone — that is the moderation model.
    await community.deletePost(post.id, alice);

    const own = await community.post(carol, bob, "My own note.");
    await community.deletePost(own.id, bob);
  });

  it("stops one person filling one wall before it stops them posting at all", async () => {
    // The per-wall limit is the harassment shape and is tighter than the global
    // spam limit, so it must be the one that fires first.
    for (let i = 0; i < POSTS_PER_WALL_PER_HOUR; i += 1) {
      await community.post(carol, alice, `flood ${i}`);
    }
    await assert.rejects(
      () => community.post(carol, alice, "one too many"),
      (error: CommunityError) => error.status === 429 && /too_many_here/.test(error.message)
    );
    // ...while the same author can still write elsewhere.
    await community.post(bob, alice, "still fine");
  });

  it("refuses a blocked author, and does not leak why", async () => {
    await community.block(carol, bob);
    await assert.rejects(
      () => community.post(carol, bob, "hello"),
      (error: CommunityError) => error.status === 403
    );
    await community.unblock(carol, bob);
  });
});

describe("friends", () => {
  it("is a request until it is accepted", async () => {
    assert.equal(await community.friendState(alice, bob), "none");
    await community.requestFriend(alice, bob);
    assert.equal(await community.friendState(alice, bob), "pending_out");
    assert.equal(await community.friendState(bob, alice), "pending_in");

    await community.acceptFriend(bob, alice);
    assert.equal(await community.friendState(alice, bob), "friends");
    assert.equal(await community.friendState(bob, alice), "friends");

    // Stored once, but readable from both sides.
    assert.deepEqual((await community.friends(alice)).map((f) => f.callsign), ["Bob"]);
    assert.deepEqual((await community.friends(bob)).map((f) => f.callsign), ["Alice"]);
  });

  it("turns a crossing request into an acceptance rather than a deadlock", async () => {
    // Both press "add friend" before either answers. A mirrored second edge
    // would leave two pending rows that can never resolve.
    await community.requestFriend(alice, carol);
    const state = await community.requestFriend(carol, alice);
    assert.equal(state, "friends");
    assert.equal(await community.friendState(alice, carol), "friends");
  });

  it("removes from either side", async () => {
    await community.removeFriendship(carol, alice);
    assert.equal(await community.friendState(alice, carol), "none");
  });

  it("refuses across a block in both directions, and ends the friendship", async () => {
    await community.block(alice, bob);
    assert.equal(await community.friendState(alice, bob), "blocked");
    // The blocked party sees a plain "none" rather than being told they are
    // blocked, and cannot re-request.
    assert.equal(await community.friendState(bob, alice), "none");
    await assert.rejects(() => community.requestFriend(bob, alice), /blocked/);
    await assert.rejects(() => community.requestFriend(alice, bob), /blocked/);
    await community.unblock(alice, bob);
  });

  it("refuses to friend yourself", async () => {
    await assert.rejects(() => community.requestFriend(alice, alice), /cannot_friend_self/);
  });

  it("reports a missing player as 404 rather than a constraint failure", async () => {
    // Every write here has a foreign key to `users` and `foreign_keys` is ON, so
    // an unchecked id surfaced as "UNIQUE/FOREIGN KEY constraint failed" and a 500.
    for (const act of [
      () => community.requestFriend(alice, 999_999),
      () => community.block(alice, 999_999),
      () => community.post(999_999, alice, "hello"),
    ]) {
      await assert.rejects(act, (error: CommunityError) => {
        assert.equal(error.status, 404);
        assert.equal(error.message, "no_such_player");
        return true;
      });
    }
  });

  it("cannot hold two edges for one pair, whichever direction they arrive in", async () => {
    // `requestFriend` reads the edge and then inserts, which is a window: two
    // people pressing the button at the same moment both saw no edge and both
    // inserted. The old unique index on (requester_id, addressee_id) could not
    // catch it, because (A,B) and (B,A) are different keys — so `pair_key` exists
    // to make the pair itself the unique thing.
    //
    // Inserted directly, because reproducing the race through the public API would
    // need two concurrent transactions.
    const edge = (requester: number, addressee: number) => ({
      requester_id: requester,
      addressee_id: addressee,
      state: "pending" as const,
      created_at: new Date().toISOString(),
      responded_at: null,
      pair_key: pairKey(requester, addressee),
    });
    await db.insertInto("friendships").values(edge(alice, dave)).execute();
    await assert.rejects(
      () => db.insertInto("friendships").values(edge(dave, alice)).execute(),
      /UNIQUE constraint failed/,
      "the reversed pair must be refused by the database, not just by the read above it"
    );
    await community.removeFriendship(alice, dave);
  });

  it("keys a pair without regard to order", () => {
    assert.equal(pairKey(3, 9), pairKey(9, 3));
    // Numerically, not as text: "10" sorts before "9", which would give (9,10)
    // and (10,9) two different keys and defeat the whole column.
    assert.equal(pairKey(9, 10), pairKey(10, 9));
    assert.notEqual(pairKey(1, 2), pairKey(1, 3));
  });
});

describe("clans", () => {
  it("validates tag and name the way callsigns are validated", () => {
    assert.notEqual(validateClanTag("A"), null);
    assert.notEqual(validateClanTag("TOOLONG"), null);
    assert.notEqual(validateClanTag("A-B"), null);
    assert.equal(validateClanTag("3rd"), null);
    assert.notEqual(validateClanName("ab"), null);
    assert.equal(validateClanName("Third Rangers"), null);
  });

  it("is founded, joined and tagged", async () => {
    const clan = await community.createClan(alice, "3rd", "Third Rangers");
    assert.equal(clan.tag, "3RD");
    assert.equal(clan.members.length, 1);
    assert.equal(clan.members[0]?.role, "leader");

    await community.joinClan(bob, "3rd");
    assert.equal((await community.clanOf(bob))?.tag, "3RD");
    assert.equal((await community.clanByTag("3RD"))?.memberCount, 2);
    // Looked up case-insensitively, because it gets typed from memory.
    assert.equal((await community.clanByTag("3rd"))?.name, "Third Rangers");
  });

  it("allows one clan per player and one tag in the world", async () => {
    await assert.rejects(() => community.joinClan(bob, "3rd"), /already_in_clan/);
    await assert.rejects(() => community.createClan(carol, "3RD", "Impostors"), /tag_taken/);
  });

  it("hands leadership on when the leader leaves, and disbands when nobody is left", async () => {
    // The leader leaving used to be REFUSED (`promote_first`) with no promote
    // endpoint in existence, so any stranger joining trapped the founder and
    // their tag forever. Succession is automatic and goes to the
    // longest-standing member.
    await community.leaveClan(alice);
    assert.equal(await community.clanOf(alice), null, "the leader did not leave");
    const clan = await community.clanByTag("3RD");
    assert.equal(clan?.memberCount, 1, "the clan should survive its founder");
    assert.equal(
      clan?.members[0]?.role,
      "leader",
      "the remaining member must be promoted, or the clan has no leader"
    );

    // Alone now, so leaving disbands rather than stranding the clan.
    await community.leaveClan(bob);
    assert.equal(await community.clanByTag("3RD"), null);
  });

  it("lets a leader choose their successor without leaving", async () => {
    await community.createClan(alice, "4th", "Fourth");
    await community.joinClan(bob, "4th");
    await assert.rejects(() => community.promoteClanMember(bob, alice), /not_leader/);
    await assert.rejects(() => community.promoteClanMember(alice, carol), /not_a_member/);
    await community.promoteClanMember(alice, bob);
    const clan = await community.clanByTag("4TH");
    const roleOf = (id: number) => clan?.members.find((m) => m.id === id)?.role;
    assert.equal(roleOf(bob), "leader");
    assert.equal(roleOf(alice), "member", "there must never be two leaders");
  });
});

describe("the activity feed", () => {
  it("is derived from the tables that already hold the facts", async () => {
    await accounts.recordSession(bob, 60);
    await accounts.syncMedals(bob);
    await community.post(alice, bob, "Nice shot.");
    const feed = await community.activity(bob);

    assert.ok(feed.length >= 2, "expected a medal and a post");
    assert.ok(feed.some((entry) => entry.kind === "medal"));
    assert.ok(feed.some((entry) => entry.text === "Wrote on Alice's wall"));
    // Newest first, and no stored table to fall out of step with the source.
    const times = feed.map((entry) => entry.at);
    assert.deepEqual(times, [...times].sort((a, b) => b.localeCompare(a)));
  });
});
