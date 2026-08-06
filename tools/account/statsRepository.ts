// Population-wide statistics: the leaderboard, weapons and maps.
//
// SERVER ONLY. Separate from communityRepository.ts because these read ACROSS
// every account rather than about one — different query shapes, different cost,
// and a slow population aggregate must not be able to make a profile page slow.
//
// Every ranked figure is computed through src/account/playerStats.ts, so the
// board and the profile can never disagree about what a player's rank points
// are. Design record: docs/plans/2026-08-04-player-statistics-design.md.
//
// THE RULE FOR EVERY QUERY HERE: aggregate in SQL, and never read a row per shot
// when a count will do. These are public, unauthenticated routes over tables that
// grow with the whole population, so anything O(players x rows) is a denial of
// service that testing cannot show you while the tables are empty. Reads that
// genuinely need individual values — a median cannot come from a count — are
// restricted to `fatal = 1`. See the design record section 6.

import { sql } from "kysely";
import {
  combatRating,
  killDeathRatio,
  median,
  rankPoints,
  winRate,
  type PlayerStats,
} from "../../src/account/playerStats.ts";
import type { TierId } from "../../src/account/tiers.ts";
import type { AccountDb } from "./database.ts";

/**
 * How many accounts the board is willing to SCORE in one request.
 *
 * The bound exists because scoring is TypeScript and the route is public; the
 * pool is ordered by an upper bound on points, so the real leaders are always
 * inside it. Ten times the largest board anyone asks for.
 */
const CANDIDATE_POOL = 500;

export interface LeaderboardEntry {
  rank: number;
  id: number;
  callsign: string;
  tier: TierId;
  clanTag: string | null;
  points: number;
  rating: number;
  kills: number;
  deaths: number;
  kd: number | null;
  winRate: number | null;
  medianRangeMetres: number | null;
  consistency: number | null;
  timePlayedSeconds: number;
}

export interface WeaponRow {
  weaponId: string;
  kills: number;
  share: number;
  shots: number;
  shotsPerKill: number | null;
  headshots: number;
  headshotRate: number | null;
  medianRangeMetres: number | null;
  users: number;
}

export interface MapRow {
  map: string;
  matches: number;
  players: number;
  averageMatchMinutes: number | null;
  medianRangeMetres: number | null;
  proneShare: number | null;
}

export class StatsRepository {
  private readonly db: AccountDb;

  constructor(db: AccountDb) {
    this.db = db;
  }

  /**
   * The board.
   *
   * Every total is summed BY THE DATABASE, grouped by player. The first version
   * read the rows and summed them in JavaScript with
   * `participation.filter(e => e.user_id === row.id)` inside `players.map(...)`,
   * which is O(players x rows) — a thousand accounts against a hundred thousand
   * participation rows is a hundred million comparisons per request, on a public
   * endpoint. It also passed every account id as a bound parameter to
   * `where("user_id", "in", ids)`, which has a hard ceiling in SQLite.
   *
   * Guests are excluded, as they are from every board — a per-browser account is
   * disposable, and ranking them rewards clearing your storage. The exclusion is
   * in the aggregate joins too, so their rows are never even summed.
   */
  /**
   * The scored board.
   *
   * `rankPoints` is TypeScript, so the SCORING cannot move into SQL — but the
   * candidate set can be bounded, and on a public unauthenticated route it has
   * to be: reading every non-guest account to score it in JavaScript is
   * O(population) per request (design record §5.7 category 3).
   *
   * Two bounds, both safe. An account with no career and no participation scores
   * exactly zero — every term of `rankPoints` is non-negative and derived from
   * kills, wins or hours — so filtering those out cannot remove anybody who
   * would have placed. And the rest are ordered by an SQL UPPER BOUND on their
   * points (`wins <= matches`, `hours * 2 = seconds / 1800`, `reach <= 2`) and
   * capped, so the pool always contains the real leaders. Truncation is logged
   * rather than silent.
   */
  async leaderboard(limit = 50): Promise<LeaderboardEntry[]> {
    const players = await this.db
      .selectFrom("users")
      .leftJoin("career", "career.user_id", "users.id")
      .leftJoin("clan_members", "clan_members.user_id", "users.id")
      .leftJoin("clans", "clans.id", "clan_members.clan_id")
      .select([
        "users.id",
        "users.callsign",
        "users.tier",
        "clans.tag as clan_tag",
        "career.kills",
        "career.deaths",
        "career.matches",
        "career.time_played_seconds",
        "career.longest_shot_metres",
      ])
      .where("users.anonymous", "=", 0)
      .where((eb) =>
        eb.or([
          eb("career.kills", ">", 0),
          eb("career.matches", ">", 0),
          eb("career.time_played_seconds", ">", 0),
          // Participation is its own activity source — `wins` come from here and
          // not from `career` — so a player with match rows and an untouched
          // career still belongs on the board.
          eb.exists(
            eb
              .selectFrom("match_participation")
              .select("match_participation.user_id")
              .whereRef("match_participation.user_id", "=", "users.id")
          ),
        ])
      )
      .orderBy(
        sql`coalesce(career.kills, 0) * 2 + coalesce(career.matches, 0) * 10 + coalesce(career.time_played_seconds, 0) / 1800.0`,
        "desc"
      )
      .limit(CANDIDATE_POOL)
      .execute();
    if (players.length === 0) return [];
    if (players.length === CANDIDATE_POOL) {
      console.warn(
        `[stats] leaderboard candidate pool hit its cap of ${CANDIDATE_POOL}; ` +
          `players outside the top ${CANDIDATE_POOL} by potential points were not scored.`
      );
    }

    const [participation, fatalRanges] = await Promise.all([
      this.db
        .selectFrom("match_participation")
        .innerJoin("users", "users.id", "match_participation.user_id")
        .select(({ fn }) => [
          "match_participation.user_id",
          fn.sum<number>("match_participation.shots_fired").as("shots_fired"),
          fn.sum<number>("match_participation.prone_ms").as("prone_ms"),
          fn.sum<number>("match_participation.moving_ms").as("moving_ms"),
          fn.sum<number>("match_participation.concealed_ms").as("concealed_ms"),
        ])
        .select(countWhere("result", "win").as("wins"))
        .select(countWhere("result", "loss").as("losses"))
        .select(countWhere("result", "draw").as("draws"))
        .select(({ fn }) => fn.countAll<number>().as("appearances"))
        .where("users.anonymous", "=", 0)
        .groupBy("match_participation.user_id")
        .execute(),
      // Only FATAL rows, because the median is a median of kill ranges. Reading
      // every shot to keep the 1-in-n that killed somebody was the bulk of this
      // query's cost.
      this.db
        .selectFrom("engagements")
        .innerJoin("users", "users.id", "engagements.shooter_id")
        .select(["engagements.shooter_id", "engagements.range_metres"])
        .where("engagements.fatal", "=", 1)
        .where("users.anonymous", "=", 0)
        .execute(),
    ]);

    const summed = new Map(participation.map((row) => [row.user_id, row]));
    const rangesByPlayer = new Map<number, number[]>();
    for (const row of fatalRanges) {
      const bucket = rangesByPlayer.get(row.shooter_id);
      if (bucket === undefined) rangesByPlayer.set(row.shooter_id, [row.range_metres]);
      else bucket.push(row.range_metres);
    }

    const scored = players.map((row) => {
      const mine = summed.get(row.id);
      const ranges = rangesByPlayer.get(row.id) ?? [];
      const stats: PlayerStats = {
        combat: {
          kills: row.kills ?? 0,
          deaths: row.deaths ?? 0,
          headshots: 0,
          shotsFired: Number(mine?.shots_fired ?? 0),
          sniperKills: 0,
          pistolKills: 0,
          knifeKills: 0,
          suicides: 0,
          teamKills: 0,
          bestStreak: 0,
          longestShotMetres: row.longest_shot_metres ?? 0,
        },
        activity: {
          matches: row.matches ?? 0,
          timePlayedSeconds: row.time_played_seconds ?? 0,
          firstSeen: null,
          lastSeen: null,
          wins: Number(mine?.wins ?? 0),
          losses: Number(mine?.losses ?? 0),
          draws: Number(mine?.draws ?? 0),
          firstBloods: 0,
          proneMs: Number(mine?.prone_ms ?? 0),
          movingMs: Number(mine?.moving_ms ?? 0),
          concealedMs: Number(mine?.concealed_ms ?? 0),
        },
        ranges: [],
        medianRangeMetres: median(ranges),
        firstRoundHitRate: null,
        available: {
          engagements: ranges.length > 0,
          objectives: Number(mine?.appearances ?? 0) > 0,
        },
      };
      return { row, stats, points: rankPoints(stats) };
    });

    const best = scored.reduce((top, entry) => Math.max(top, entry.points), 0);
    return scored
      .sort((a, b) => b.points - a.points || a.row.callsign.localeCompare(b.row.callsign))
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((entry, index) => ({
        rank: index + 1,
        id: entry.row.id,
        callsign: entry.row.callsign,
        tier: entry.row.tier,
        clanTag: entry.row.clan_tag ?? null,
        points: entry.points,
        rating: combatRating(entry.points, best),
        kills: entry.stats.combat.kills,
        deaths: entry.stats.combat.deaths,
        kd: killDeathRatio(entry.stats.combat),
        winRate: winRate(entry.stats.activity),
        medianRangeMetres: entry.stats.medianRangeMetres,
        // Per-match kill counts are not recorded yet, so consistency stays
        // unknown rather than being invented from a lifetime total. `consistency`
        // itself is tested; this is the caller it is waiting for.
        consistency: null,
        timePlayedSeconds: entry.stats.activity.timePlayedSeconds,
      }));
  }

  /**
   * Just the names, for the compare page's two pickers.
   *
   * Its own query rather than `leaderboard(200)`, which is what it used to call:
   * that ran every aggregate above, scored the whole population and sorted it, to
   * then throw away all but two columns.
   */
  async players(limit = 200): Promise<{ id: number; callsign: string }[]> {
    return await this.db
      .selectFrom("users")
      .select(["id", "callsign"])
      .where("anonymous", "=", 0)
      .orderBy("callsign", "asc")
      .limit(Math.max(1, Math.min(500, limit)))
      .execute();
  }

  /**
   * What the population actually fights with.
   *
   * COUNTED IN SQL. The first version selected every row of `engagements` — one
   * row per shot fired by everyone who has ever played — and grouped them in
   * memory with `byWeapon.set(id, [...previous, row])`, which reallocates the
   * whole accumulated array on every row and is therefore quadratic in shots per
   * weapon. Both halves of that were unbounded on a public endpoint.
   *
   * The medians still need individual values, so they are read separately and
   * only for FATAL rows: a kill range median cannot be computed from counts, but
   * it also does not need the 99% of shots that hit nobody.
   */
  async weapons(): Promise<WeaponRow[]> {
    const [totals, fatal] = await Promise.all([
      this.db
        .selectFrom("engagements")
        .select(({ fn }) => [
          "weapon_id",
          fn.countAll<number>().as("shots"),
          fn.sum<number>("fatal").as("kills"),
          fn.sum<number>("headshot").as("headshots"),
          fn.count<number>("shooter_id").distinct().as("users"),
        ])
        .groupBy("weapon_id")
        .execute(),
      this.db
        .selectFrom("engagements")
        .select(["weapon_id", "range_metres"])
        .where("fatal", "=", 1)
        .execute(),
    ]);
    if (totals.length === 0) return [];

    const rangesByWeapon = new Map<string, number[]>();
    for (const row of fatal) {
      const bucket = rangesByWeapon.get(row.weapon_id);
      if (bucket === undefined) rangesByWeapon.set(row.weapon_id, [row.range_metres]);
      else bucket.push(row.range_metres);
    }

    const totalKills = totals.reduce((sum, row) => sum + Number(row.kills ?? 0), 0);
    return totals
      .map((row) => {
        const kills = Number(row.kills ?? 0);
        const shots = Number(row.shots ?? 0);
        const headshots = Number(row.headshots ?? 0);
        return {
          weaponId: row.weapon_id,
          kills,
          share: totalKills === 0 ? 0 : kills / totalKills,
          shots,
          shotsPerKill: kills === 0 ? null : shots / kills,
          headshots,
          headshotRate: kills === 0 ? null : headshots / kills,
          medianRangeMetres: median(rangesByWeapon.get(row.weapon_id) ?? []),
          users: Number(row.users ?? 0),
        };
      })
      .sort((a, b) => b.kills - a.kills);
  }

  /**
   * How each map actually plays.
   *
   * The engagement ranges are attributed to a map through a match_id LOOKUP, not
   * through a join. Joining `engagements` to `match_participation` on `match_id`
   * duplicates every engagement once per participant in that match, which was
   * wrong twice over: it multiplied the rows read by the average player count,
   * and it weighted each match's ranges by how many people were in it — so a
   * 16-player match counted sixteen times as much as a duel, and the reported
   * "median range" was not the median of anything.
   */
  /**
   * Per-map figures, COUNTED IN SQL.
   *
   * This is a public unauthenticated route, so the cost has to be bounded by the
   * number of maps rather than by the number of rows: reading every
   * `match_participation` row into JavaScript to group it is a denial of service
   * waiting for a population (design record §5.7 category 3, and the previous
   * shape of this method contradicted the claim the stats record makes about it).
   *
   * The medians are the one thing left in JS, and deliberately: a median needs
   * the values, and the read is narrowed to `fatal = 1` engagement ranges joined
   * to their map — the same rows the weapons page already reads.
   */
  async maps(): Promise<MapRow[]> {
    const [grouped, fatal] = await Promise.all([
      this.db
        .selectFrom("match_participation")
        .select((eb) => [
          "map",
          eb.fn.count<number>("match_id").distinct().as("matches"),
          eb.fn.count<number>("user_id").distinct().as("players"),
          eb.fn.sum<number>("prone_ms").as("prone_ms"),
          eb.fn.sum<number>("moving_ms").as("moving_ms"),
          // Average match length in minutes. `julianday` is SQLite's date
          // arithmetic; the day-to-minute factor is the 1440 below.
          sql<number | null>`avg((julianday(left_at) - julianday(joined_at)) * 1440)`.as(
            "average_minutes"
          ),
        ])
        .groupBy("map")
        .orderBy("matches", "desc")
        .execute(),
      // Only the fatal rows, and each one ONCE — the map comes from a scalar
      // subquery rather than a join, because joining `match_participation`
      // repeats every engagement once per player in that match. That is the
      // 200-vs-550 median bug the review found: a join that changed the answer,
      // not just the cost (design record §5.7 category 4), and the tests below
      // pin it. `distinctOn` would also fix it and is Postgres-only.
      this.db
        .selectFrom("engagements")
        .select((eb) => [
          "engagements.range_metres as range_metres",
          eb
            .selectFrom("match_participation")
            .select("match_participation.map")
            .whereRef("match_participation.match_id", "=", "engagements.match_id")
            .limit(1)
            .as("map"),
        ])
        .where("engagements.fatal", "=", 1)
        .execute(),
    ]);
    if (grouped.length === 0) return [];

    const rangesByMap = new Map<string, number[]>();
    for (const row of fatal) {
      // An engagement whose match has no participation row has no map to belong
      // to; counting it against every map would be worse than dropping it.
      if (row.map === null) continue;
      const bucket = rangesByMap.get(row.map);
      if (bucket === undefined) rangesByMap.set(row.map, [row.range_metres]);
      else bucket.push(row.range_metres);
    }

    return grouped.map((row) => {
      const prone = Number(row.prone_ms ?? 0);
      const moving = Number(row.moving_ms ?? 0);
      return {
        map: row.map,
        matches: Number(row.matches),
        players: Number(row.players),
        averageMatchMinutes: row.average_minutes === null ? null : Number(row.average_minutes),
        medianRangeMetres: median(rangesByMap.get(row.map) ?? []),
        proneShare: prone + moving === 0 ? null : prone / (prone + moving),
      };
    });
  }
}

/**
 * `sum(case when <column> = <value> then 1 else 0 end)`.
 *
 * A template rather than Kysely's case builder because it has to read as one
 * aggregate in a select list, and because `count(...) filter (where ...)` — the
 * tidier spelling — is Postgres-only and this runs on SQLite today.
 */
function countWhere(column: "result", value: string) {
  return sql<number>`sum(case when ${sql.ref(`match_participation.${column}`)} = ${value} then 1 else 0 end)`;
}
