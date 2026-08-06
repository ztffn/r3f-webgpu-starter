// Player statistics: the shapes a stats page renders, and the verdicts derived
// from them.
//
// Shared and pure. The server gathers rows and calls these; the client renders
// the result and can recompute a verdict without a round trip. Nothing here is
// stored — a derived ratio goes stale the moment a source row is corrected, so
// K/D, the range bands and the play-style verdict are all computed on read.
//
// EVERY FUNCTION HERE RETURNS null FOR UNKNOWN, never a number. The trap is not
// the obvious zero, it is the plausible middle: `patienceScore` answered a
// confident 40/100 for every player alive, because zero stance telemetry reads as
// "never moved" and a perfect restraint score. When adding a metric, ask what it
// answers with no source rows, and make that answer null.
//
// The vocabulary is dfhub.net's, which is Delta Force's, because this project is
// that game's successor and its players already know what these terms mean.
// Design record: docs/plans/2026-08-04-player-statistics-design.md.

/** Range bands, in metres. The histogram that separates two kinds of player. */
export const RANGE_BANDS: readonly { label: string; min: number; max: number | null }[] = [
  { label: "0–200", min: 0, max: 200 },
  { label: "200–500", min: 200, max: 500 },
  { label: "500–800", min: 500, max: 800 },
  { label: "800–1200", min: 800, max: 1200 },
  { label: "1200+", min: 1200, max: null },
];

export interface RangeBandCount {
  label: string;
  kills: number;
}

/** Raw combat figures. Counters only — every ratio below is derived from these. */
export interface CombatTotals {
  kills: number;
  deaths: number;
  headshots: number;
  shotsFired: number;
  sniperKills: number;
  pistolKills: number;
  knifeKills: number;
  suicides: number;
  teamKills: number;
  bestStreak: number;
  longestShotMetres: number;
}

export interface ActivityTotals {
  matches: number;
  timePlayedSeconds: number;
  firstSeen: string | null;
  lastSeen: string | null;
  wins: number;
  losses: number;
  draws: number;
  firstBloods: number;
  /** Milliseconds in each stance, summed across matches. */
  proneMs: number;
  movingMs: number;
  concealedMs: number;
}

/**
 * Whether the source rows for a group exist YET.
 *
 * The same honesty the leaderboards use for an unpopulated board: a section with
 * no data renders its frame and says why, rather than rendering zeroes that read
 * as "this player has never killed anyone".
 */
export interface StatsAvailability {
  engagements: boolean;
  objectives: boolean;
}

export interface PlayerStats {
  combat: CombatTotals;
  activity: ActivityTotals;
  /** Kills by range band. Empty until `engagement` rows exist. */
  ranges: RangeBandCount[];
  /** Metres. Null when nothing has been recorded. */
  medianRangeMetres: number | null;
  /** Of engagements whose first shot connected. Null when unknown. */
  firstRoundHitRate: number | null;
  available: StatsAvailability;
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

/** Kills per death. Deathless players report their kill count, not Infinity. */
export function killDeathRatio(combat: CombatTotals): number | null {
  if (combat.deaths === 0) return combat.kills === 0 ? null : combat.kills;
  return combat.kills / combat.deaths;
}

export function headshotRate(combat: CombatTotals): number | null {
  return ratio(combat.headshots, combat.kills);
}

export function accuracy(combat: CombatTotals): number | null {
  return ratio(combat.kills, combat.shotsFired);
}

export function shotsPerKill(combat: CombatTotals): number | null {
  return ratio(combat.shotsFired, combat.kills);
}

export function winRate(activity: ActivityTotals): number | null {
  const played = activity.wins + activity.losses + activity.draws;
  return ratio(activity.wins, played);
}

export function killsPerMinute(combat: CombatTotals, activity: ActivityTotals): number | null {
  return ratio(combat.kills, activity.timePlayedSeconds / 60);
}

/**
 * How much of their time this player spends still and hidden, 0–100.
 *
 * The counterpart to dfhub's aggression index, and the one axis this game can
 * measure that Delta Force's own logs could not: `concealed_ms` comes from the
 * grass concealment field the renderer and the line-of-sight query already
 * share. A high score is the prone-and-wait player DF2 is remembered for.
 */
export function patienceScore(activity: ActivityTotals): number | null {
  const total = activity.timePlayedSeconds * 1000;
  if (total <= 0) return null;
  // No stance telemetry at all means UNMEASURED, not "never moved".
  //
  // Without this the formula answered 40/100 for everybody: `match_participation`
  // has no writer yet, so all three of these are zero, which made `stillness` 0
  // and `restraint` a perfect 1 — and 0 x 0.6 + 1 x 0.4 is a plausible-looking
  // score computed entirely from data that does not exist. A missing figure has to
  // read as missing; the pages already have the branch for it.
  if (activity.proneMs + activity.movingMs + activity.concealedMs === 0) return null;
  const stillness = (activity.proneMs + activity.concealedMs) / 2 / total;
  const restraint = 1 - Math.min(1, activity.movingMs / total);
  return Math.round(Math.max(0, Math.min(1, stillness * 0.6 + restraint * 0.4)) * 100);
}

/** The inverse framing, kept explicit so a page can show either. */
export function aggressionIndex(activity: ActivityTotals): number | null {
  const patience = patienceScore(activity);
  return patience === null ? null : 100 - patience;
}

export interface PlayStyle {
  /** The headline verdict: "Overwatch", "Assault", "Skirmisher". */
  role: string;
  /** The qualifier: "patient", "reckless", "opportunist". */
  trait: string;
  /** One line, ready to print. */
  summary: string;
}

/**
 * The verdict a recruiter reads.
 *
 * Derived from range and patience rather than from K/D, because those are the
 * two axes this game is actually about — a 1.0 K/D at 900 metres and a 1.0 K/D
 * at 50 metres describe two completely different players, and the role is the
 * fastest way to say which one is being looked at.
 *
 * Returns a plainly hedged verdict when the inputs are missing, rather than
 * guessing a role from nothing.
 */
export function describeStyle(stats: PlayerStats): PlayStyle {
  const patience = patienceScore(stats.activity);
  const range = stats.medianRangeMetres;

  if (range === null || patience === null) {
    return {
      role: "Unassessed",
      trait: "no engagements recorded",
      summary: "Not enough engagements to judge a style yet.",
    };
  }

  const role = range >= 600 ? "Overwatch" : range >= 250 ? "Marksman" : "Skirmisher";
  const trait =
    patience >= 66 ? "patient" : patience >= 33 ? "measured" : "aggressive";
  const reach =
    range >= 600 ? "long-range specialist" : range >= 250 ? "mid-range" : "close-quarters";
  return { role, trait, summary: `${role} — ${trait} ${reach}.` };
}

/** Percentage, or an em dash. One formatter so every surface agrees. */
export function formatRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function formatRatio(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

export function formatMetres(value: number | null): string {
  return value === null || value <= 0 ? "—" : `${Math.round(value).toLocaleString("en-US")} m`;
}

/** Bucket engagement ranges into the bands above. */
export function bandKills(rangesMetres: readonly number[]): RangeBandCount[] {
  return RANGE_BANDS.map((band) => ({
    label: band.label,
    kills: rangesMetres.filter(
      (range) => range >= band.min && (band.max === null || range < band.max)
    ).length,
  }));
}

/** Median of a list, or null when empty. Median not mean: one 1400 m lucky shot
 *  should not move a close-quarters player's headline figure. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/**
 * Rank points: the single number the leaderboard sorts on.
 *
 * The formula is stated here rather than in a query because it is a DESIGN
 * decision, not an implementation detail, and every surface that shows a rank
 * must use the same one.
 *
 * Three deliberate weightings, each of which changes who reaches the top:
 *
 * 1. **Objective play outscores killing.** A capture is worth more than a kill,
 *    so the board rewards the player who won the match rather than the one who
 *    farmed it. A K/D ladder with extra steps is the failure this avoids.
 * 2. **Range is the multiplier, not a bonus column.** This game is about the long
 *    shot, so a kill at 900 m is worth appreciably more than one at 50 m — and
 *    that is what stops the board reading identically to every other shooter's.
 * 3. **Time played contributes a floor, and a small one.** Turning up matters;
 *    turning up for two hundred hours must not, on its own, beat playing well.
 *
 * Team kills cost more than dying, because the thing a ladder must not reward is
 * treating team-mates as an obstacle.
 */
export function rankPoints(stats: PlayerStats): number {
  const { combat, activity } = stats;
  const hours = activity.timePlayedSeconds / 3600;
  // Median range, expressed as a multiplier around 1.0 at 300 m and capped so a
  // handful of extreme shots cannot run away with the board.
  const reach =
    stats.medianRangeMetres === null
      ? 1
      : Math.min(2, Math.max(0.8, stats.medianRangeMetres / 300));

  const fromCombat = combat.kills * 1 * reach;
  const fromObjective = 0; // objective_events are not written yet; see the design record.
  const fromResults = activity.wins * 10;
  const fromService = hours * 2;
  const penalties = combat.suicides * 2 + combat.teamKills * 5;

  return Math.max(0, Math.round(fromCombat + fromObjective + fromResults + fromService - penalties));
}

/**
 * Combat rating, 0-100, normalised against the best player on the board.
 *
 * Relative rather than absolute on purpose: an absolute scale needs a ceiling
 * nobody can justify before the game has a population, and a rating of "62" only
 * means anything next to somebody else's.
 */
export function combatRating(points: number, best: number): number {
  if (best <= 0) return 0;
  return Math.round(Math.min(100, (points / best) * 100));
}

/**
 * Consistency: how much a player's per-match kill count varies, 0-100.
 *
 * High is steady. Reported as a score rather than a raw standard deviation
 * because the number is compared BETWEEN players, and a σ of 12 means nothing
 * without knowing the mean it sits against — this is the coefficient of
 * variation, inverted and clamped.
 */
export function consistency(perMatchKills: readonly number[]): number | null {
  if (perMatchKills.length < 3) return null;
  const mean = perMatchKills.reduce((a, b) => a + b, 0) / perMatchKills.length;
  if (mean === 0) return null;
  const variance =
    perMatchKills.reduce((total, value) => total + (value - mean) ** 2, 0) /
    perMatchKills.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.round(Math.max(0, Math.min(1, 1 - cv)) * 100);
}
