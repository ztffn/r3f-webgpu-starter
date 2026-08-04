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
