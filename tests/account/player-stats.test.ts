// Derived player statistics.
//
// These are the figures a recruiter reads, so the cases worth pinning are the
// ones where a naive formula lies: a deathless player is not infinitely good, a
// single lucky 1400 m hit should not relabel a close-quarters player, and a
// profile with no engagements must refuse to guess a role rather than guessing
// the middle one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggressionIndex,
  bandKills,
  describeStyle,
  formatMetres,
  formatRate,
  headshotRate,
  killDeathRatio,
  median,
  patienceScore,
  combatRating,
  consistency,
  rankPoints,
  winRate,
  type ActivityTotals,
  type CombatTotals,
  type PlayerStats,
} from "../../src/account/playerStats.ts";

const combat = (patch: Partial<CombatTotals> = {}): CombatTotals => ({
  kills: 0,
  deaths: 0,
  headshots: 0,
  shotsFired: 0,
  sniperKills: 0,
  pistolKills: 0,
  knifeKills: 0,
  suicides: 0,
  teamKills: 0,
  bestStreak: 0,
  longestShotMetres: 0,
  ...patch,
});

const activity = (patch: Partial<ActivityTotals> = {}): ActivityTotals => ({
  matches: 0,
  timePlayedSeconds: 0,
  firstSeen: null,
  lastSeen: null,
  wins: 0,
  losses: 0,
  draws: 0,
  firstBloods: 0,
  proneMs: 0,
  movingMs: 0,
  concealedMs: 0,
  ...patch,
});

const stats = (patch: Partial<PlayerStats> = {}): PlayerStats => ({
  combat: combat(),
  activity: activity(),
  ranges: [],
  medianRangeMetres: null,
  firstRoundHitRate: null,
  available: { engagements: true, objectives: true },
  ...patch,
});

describe("ratios", () => {
  it("does not report a deathless player as infinite", () => {
    // The naive kills/deaths is Infinity, which renders as "∞" and tells a
    // reader nothing about whether one kill or two hundred produced it.
    assert.equal(killDeathRatio(combat({ kills: 7, deaths: 0 })), 7);
    assert.equal(killDeathRatio(combat({ kills: 0, deaths: 0 })), null);
    assert.equal(killDeathRatio(combat({ kills: 3, deaths: 2 })), 1.5);
  });

  it("returns null rather than zero when the denominator is missing", () => {
    // Zero and "unknown" are different claims, and only one of them is honest
    // before the combat authority work lands.
    assert.equal(headshotRate(combat({ kills: 0, headshots: 0 })), null);
    assert.equal(headshotRate(combat({ kills: 50, headshots: 4 })), 0.08);
    assert.equal(winRate(activity()), null);
    assert.equal(winRate(activity({ wins: 2, losses: 1, draws: 1 })), 0.5);
  });

  it("formats a missing figure as an em dash, never as 0", () => {
    assert.equal(formatRate(null), "—");
    assert.equal(formatRate(0.036), "3.6%");
    assert.equal(formatMetres(null), "—");
    assert.equal(formatMetres(0), "—");
    assert.equal(formatMetres(1143.6), "1,144 m");
  });
});

describe("range", () => {
  it("uses the median so one lucky shot cannot relabel a player", () => {
    // Nine close engagements and one extreme one. A mean would report 195 m and
    // call this a marksman; the median says what they actually do.
    const ranges = [40, 55, 60, 62, 70, 75, 80, 90, 110, 1400];
    assert.equal(median(ranges), 72.5);
  });

  it("buckets kills into bands, with the open top band inclusive", () => {
    const bands = bandKills([50, 210, 640, 900, 1300, 1250]);
    assert.deepEqual(
      bands.map((band) => band.kills),
      [1, 1, 1, 1, 2]
    );
  });

  it("is empty rather than zeroed when nothing is recorded", () => {
    assert.deepEqual(bandKills([]).map((band) => band.kills), [0, 0, 0, 0, 0]);
  });
});

describe("patience", () => {
  it("scores a prone, concealed, stationary player high", () => {
    const still = activity({
      timePlayedSeconds: 1000,
      proneMs: 800_000,
      concealedMs: 900_000,
      movingMs: 50_000,
    });
    const score = patienceScore(still)!;
    assert.ok(score >= 80, `expected a high score, got ${score}`);
    assert.equal(aggressionIndex(still), 100 - score);
  });

  it("scores a constantly moving player low", () => {
    const runner = activity({
      timePlayedSeconds: 1000,
      proneMs: 0,
      concealedMs: 0,
      movingMs: 950_000,
    });
    assert.ok(patienceScore(runner)! <= 10);
  });

  it("is unknown with no time played, not zero", () => {
    assert.equal(patienceScore(activity()), null);
  });

  it("is unknown when no stance telemetry was recorded, not a plausible 40", () => {
    // `match_participation` has no writer yet, so all three stance counters are
    // zero for everybody. Zero prone and zero concealed made `stillness` 0, and
    // zero moving made `restraint` a perfect 1 — so the formula answered
    // 0 x 0.6 + 1 x 0.4 = 40/100 for every player who had ever been in a match,
    // computed entirely from data that does not exist. Unmeasured has to read as
    // unmeasured; the profile page already has the branch for it.
    const played = activity({
      timePlayedSeconds: 3600,
      proneMs: 0,
      movingMs: 0,
      concealedMs: 0,
    });
    assert.equal(patienceScore(played), null);
    assert.equal(aggressionIndex(played), null);
  });

  it("still scores a player who genuinely only ever moved", () => {
    // One non-zero counter is enough to mean "this was measured", so the low score
    // a sprinter earns is not confused with the absence of any measurement.
    const sprinter = activity({ timePlayedSeconds: 100, movingMs: 100_000 });
    assert.equal(patienceScore(sprinter), 0);
  });
});

describe("the verdict", () => {
  it("refuses to guess a role with no engagements", () => {
    // The failure this prevents: an unassessed player defaulting to the middle
    // role and reading as a real judgement about them.
    const verdict = describeStyle(stats());
    assert.equal(verdict.role, "Unassessed");
    assert.match(verdict.summary, /Not enough engagements/);
  });

  it("separates two players with the same K/D by the range they fight at", () => {
    const shared = { timePlayedSeconds: 1000, proneMs: 700_000, concealedMs: 800_000, movingMs: 60_000 };
    const sniper = describeStyle(
      stats({ medianRangeMetres: 880, activity: activity(shared) })
    );
    const closeIn = describeStyle(
      stats({ medianRangeMetres: 90, activity: activity({ ...shared, proneMs: 0, concealedMs: 0, movingMs: 900_000 }) })
    );
    assert.equal(sniper.role, "Overwatch");
    assert.equal(sniper.trait, "patient");
    assert.equal(closeIn.role, "Skirmisher");
    assert.equal(closeIn.trait, "aggressive");
    assert.notEqual(sniper.summary, closeIn.summary);
  });
});

describe("rank points", () => {
  it("values a won match above a handful of kills", () => {
    // The board must reward winning, not farming. Ten kills and no wins should
    // not out-score four kills and two wins.
    const farmer = rankPoints(
      stats({ combat: combat({ kills: 10 }), medianRangeMetres: 300 })
    );
    const winner = rankPoints(
      stats({ combat: combat({ kills: 4 }), activity: activity({ wins: 2 }), medianRangeMetres: 300 })
    );
    assert.ok(winner > farmer, `winner ${winner} should beat farmer ${farmer}`);
  });

  it("pays more for the same kills taken at range", () => {
    const close = rankPoints(stats({ combat: combat({ kills: 20 }), medianRangeMetres: 60 }));
    const far = rankPoints(stats({ combat: combat({ kills: 20 }), medianRangeMetres: 900 }));
    assert.ok(far > close, "range is the multiplier this game is about");
  });

  it("does not let time played alone beat playing well", () => {
    const grinder = rankPoints(stats({ activity: activity({ timePlayedSeconds: 200 * 3600 }) }));
    const good = rankPoints(
      stats({ combat: combat({ kills: 300 }), activity: activity({ wins: 40 }), medianRangeMetres: 800 })
    );
    assert.ok(good > grinder, `${good} should beat ${grinder}`);
  });

  it("punishes team killing harder than dying", () => {
    const clean = rankPoints(stats({ combat: combat({ kills: 20 }), medianRangeMetres: 300 }));
    const teamKiller = rankPoints(
      stats({ combat: combat({ kills: 20, teamKills: 4 }), medianRangeMetres: 300 })
    );
    assert.ok(clean - teamKiller >= 20);
  });

  it("never goes negative", () => {
    assert.equal(rankPoints(stats({ combat: combat({ teamKills: 99 }) })), 0);
  });
});

describe("rating and consistency", () => {
  it("rates against the best on the board, not an invented ceiling", () => {
    assert.equal(combatRating(500, 1000), 50);
    assert.equal(combatRating(1000, 1000), 100);
    assert.equal(combatRating(10, 0), 0);
  });

  it("scores a steady player above a streaky one", () => {
    const steady = consistency([10, 11, 9, 10, 10])!;
    const streaky = consistency([1, 30, 2, 25, 0])!;
    assert.ok(steady > streaky, `${steady} should beat ${streaky}`);
  });

  it("declines to score fewer than three matches", () => {
    assert.equal(consistency([10, 12]), null);
  });
});
