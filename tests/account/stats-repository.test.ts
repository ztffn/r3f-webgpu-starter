// The population statistics aggregates, against a real database with real rows.
//
// These exist because the queries were rewritten to aggregate in SQL rather than
// in JavaScript, and the two things that rewrite could break are invisible from a
// page: whether a total still adds up, and whether a median is a median of the
// right multiset. The map median is the sharp one — it used to be weighted by how
// many players were in each match, so this file pins the weighting explicitly.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { migrate, openDatabase, type AccountDb } from "../../tools/account/database.ts";
import { AccountRepository } from "../../tools/account/repository.ts";
import { StatsRepository } from "../../tools/account/statsRepository.ts";

let db: AccountDb;
let accounts: AccountRepository;
let stats: StatsRepository;

let ada = 0;
let bree = 0;

/** A participation row with everything the schema needs and nothing interesting. */
function participation(overrides: {
  user_id: number;
  match_id: string;
  map: string;
  joined_at?: string;
  left_at?: string;
  result?: "win" | "loss" | "draw" | "unknown";
  prone_ms?: number;
  moving_ms?: number;
  concealed_ms?: number;
  shots_fired?: number;
  best_streak?: number;
}) {
  return {
    mode: "deathmatch",
    team: null,
    joined_at: "2026-08-01T10:00:00.000Z",
    left_at: "2026-08-01T10:20:00.000Z",
    result: "unknown" as const,
    score: 0,
    objective_score: 0,
    support_score: 0,
    prone_ms: 0,
    crouch_ms: 0,
    stand_ms: 0,
    moving_ms: 0,
    concealed_ms: 0,
    shots_fired: 0,
    best_streak: 0,
    ...overrides,
  };
}

/** An engagement row. `fatal` is what every range statistic filters on. */
function engagement(overrides: {
  match_id: string;
  shooter_id: number;
  weapon_id: string;
  range_metres: number;
  fatal?: number;
  headshot?: number;
  hit?: number;
}) {
  return {
    target_id: null,
    at: "2026-08-01T10:05:00.000Z",
    hit: 1,
    fatal: 1,
    headshot: 0,
    shooter_stance: "prone",
    hold_ms: 0,
    first_of_engagement: 1,
    ...overrides,
  };
}

before(async () => {
  db = openDatabase(":memory:");
  await migrate(db);
  accounts = new AccountRepository(db);
  stats = new StatsRepository(db);
  ada = (
    await accounts.registerWithEmailAndPassword({
      email: "ada@example.com",
      passwordHash: "h",
      callsign: "Ada",
    })
  ).id;
  bree = (
    await accounts.registerWithEmailAndPassword({
      email: "bree@example.com",
      passwordHash: "h",
      callsign: "Bree",
    })
  ).id;
});

after(async () => {
  await db.destroy();
});

describe("an empty database", () => {
  it("answers with empty lists rather than throwing", async () => {
    // Every one of these runs its SQL before the early return, so this is the
    // cheapest check that the new aggregates are valid statements at all.
    assert.deepEqual(await stats.weapons(), []);
    assert.deepEqual(await stats.maps(), []);
    // An account that has never played is not RANKED. It used to be listed with
    // zero points, which both padded the board with people who had not earned a
    // place and made the query O(population) on a public route; the page has its
    // own "nobody ranked yet" state for this.
    assert.deepEqual(await stats.leaderboard(), []);
  });
});

describe("the board", () => {
  it("sums a player's participation rows in the database, not per player in memory", async () => {
    await db
      .insertInto("match_participation")
      .values([
        participation({
          user_id: ada,
          match_id: "m1",
          map: "green-mile",
          result: "win",
          shots_fired: 30,
          prone_ms: 60_000,
          moving_ms: 20_000,
        }),
        participation({
          user_id: ada,
          match_id: "m2",
          map: "green-mile",
          result: "loss",
          shots_fired: 12,
          prone_ms: 5_000,
          moving_ms: 40_000,
        }),
        participation({ user_id: bree, match_id: "m1", map: "green-mile", result: "loss" }),
      ])
      .execute();

    const board = await stats.leaderboard();
    const row = board.find((entry) => entry.id === ada)!;
    // One win of two decided matches.
    assert.equal(row.winRate, 0.5);
    // Consistency has no per-match kill source yet, so it must stay unknown
    // rather than being derived from a lifetime total.
    assert.equal(row.consistency, null);
  });

  it("excludes guests from the aggregate as well as from the board", async () => {
    const guest = await accounts.createGuest("stats-guest");
    await db
      .insertInto("match_participation")
      .values(participation({ user_id: guest.id, match_id: "m3", map: "green-mile", result: "win" }))
      .execute();
    const board = await stats.leaderboard();
    assert.equal(board.some((entry) => entry.id === guest.id), false);
  });

  it("offers names through its own query rather than the whole scored board", async () => {
    const players = await stats.players();
    assert.deepEqual(
      players.map((player) => player.callsign),
      ["Ada", "Bree"]
    );
    // Two columns and nothing else — the compare page's pickers need no more.
    assert.deepEqual(Object.keys(players[0]!).sort(), ["callsign", "id"]);
  });
});

describe("weapons", () => {
  before(async () => {
    await db
      .insertInto("engagements")
      .values([
        // Three kills with the rifle at 100, 200 and 900 m, plus one miss.
        engagement({ match_id: "m1", shooter_id: ada, weapon_id: "m4", range_metres: 100 }),
        engagement({ match_id: "m1", shooter_id: ada, weapon_id: "m4", range_metres: 200 }),
        engagement({
          match_id: "m1",
          shooter_id: bree,
          weapon_id: "m4",
          range_metres: 900,
          headshot: 1,
        }),
        engagement({
          match_id: "m1",
          shooter_id: ada,
          weapon_id: "m4",
          range_metres: 50,
          fatal: 0,
          hit: 0,
        }),
      ])
      .execute();
  });

  it("counts shots, kills, headshots and distinct users", async () => {
    const rifle = (await stats.weapons()).find((row) => row.weaponId === "m4")!;
    assert.equal(rifle.shots, 4, "every row is a shot");
    assert.equal(rifle.kills, 3, "only the fatal ones are kills");
    assert.equal(rifle.headshots, 1);
    assert.equal(rifle.users, 2, "distinct shooters, not shots");
    assert.equal(rifle.share, 1, "the only weapon in use");
  });

  it("takes the median over kill ranges only, ignoring the misses", async () => {
    const rifle = (await stats.weapons()).find((row) => row.weaponId === "m4")!;
    // Kills at 100, 200, 900. The 50 m miss must not pull the median down.
    assert.equal(rifle.medianRangeMetres, 200);
  });
});

describe("maps", () => {
  it("weights each kill range once, not once per player in the match", async () => {
    // The bug this pins: attributing engagements to a map by JOINING on match_id
    // duplicated every engagement once per participant, so each match's ranges
    // were weighted by how many people were in it.
    //
    // Measured against this exact fixture, the join read 9 engagement rows where
    // 5 exist and produced the multiset {100, 100, 200, 200, 900, 900, 1000} —
    // m1's three kills doubled by its two participants — for a median of 200.
    // Counted once each it is {100, 200, 900, 1000}, whose median is 550.
    await db
      .insertInto("engagements")
      .values(engagement({ match_id: "m2", shooter_id: ada, weapon_id: "m4", range_metres: 1000 }))
      .execute();

    const mile = (await stats.maps()).find((row) => row.map === "green-mile")!;
    assert.equal(mile.medianRangeMetres, 550);
    assert.notEqual(mile.medianRangeMetres, 200, "the player-count-weighted answer");
  });

  it("counts distinct matches and players", async () => {
    const mile = (await stats.maps()).find((row) => row.map === "green-mile")!;
    assert.equal(mile.matches, 3, "m1, m2 and the guest's m3");
    assert.equal(mile.players, 3, "ada, bree and the guest");
  });
});
