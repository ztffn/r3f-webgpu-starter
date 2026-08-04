// Population-wide statistics: the leaderboard, weapons and maps.
//
// SERVER ONLY. Separate from communityRepository.ts because these read ACROSS
// every account rather than about one — different query shapes, different cost,
// and a slow population aggregate must not be able to make a profile page slow.
//
// Every ranked figure is computed through src/account/playerStats.ts, so the
// board and the profile can never disagree about what a player's rank points
// are. Design record: docs/plans/2026-08-04-player-statistics-design.md.

import {
  combatRating,
  consistency,
  killDeathRatio,
  median,
  rankPoints,
  winRate,
  type PlayerStats,
} from "../../src/account/playerStats.ts";
import type { TierId } from "../../src/account/tiers.ts";
import type { AccountDb } from "./database.ts";

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
   * Assembled in one pass over three small aggregates rather than a query per
   * player: the population is the whole point of this page, and N+1 reads would
   * make it the slowest thing on the site the moment anyone uses it.
   *
   * Guests are excluded, as they are from every board — a per-browser account is
   * disposable, and ranking them rewards clearing your storage.
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
      .execute();
    if (players.length === 0) return [];

    const ids = players.map((row) => row.id);
    const [participation, engagements] = await Promise.all([
      this.db
        .selectFrom("match_participation")
        .select([
          "user_id",
          "result",
          "prone_ms",
          "moving_ms",
          "concealed_ms",
          "shots_fired",
        ])
        .where("user_id", "in", ids)
        .execute(),
      this.db
        .selectFrom("engagements")
        .select(["shooter_id", "range_metres", "fatal", "headshot"])
        .where("shooter_id", "in", ids)
        .execute(),
    ]);

    const byPlayer = new Map<number, { ranges: number[]; kills: number[] }>();
    for (const row of engagements) {
      const bucket = byPlayer.get(row.shooter_id) ?? { ranges: [], kills: [] };
      if (row.fatal === 1) bucket.ranges.push(row.range_metres);
      byPlayer.set(row.shooter_id, bucket);
    }

    const scored = players.map((row) => {
      const mine = participation.filter((entry) => entry.user_id === row.id);
      const ranges = byPlayer.get(row.id)?.ranges ?? [];
      const stats: PlayerStats = {
        combat: {
          kills: row.kills ?? 0,
          deaths: row.deaths ?? 0,
          headshots: 0,
          shotsFired: mine.reduce((total, entry) => total + entry.shots_fired, 0),
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
          wins: mine.filter((entry) => entry.result === "win").length,
          losses: mine.filter((entry) => entry.result === "loss").length,
          draws: mine.filter((entry) => entry.result === "draw").length,
          firstBloods: 0,
          proneMs: mine.reduce((total, entry) => total + entry.prone_ms, 0),
          movingMs: mine.reduce((total, entry) => total + entry.moving_ms, 0),
          concealedMs: mine.reduce((total, entry) => total + entry.concealed_ms, 0),
        },
        ranges: [],
        medianRangeMetres: median(ranges),
        firstRoundHitRate: null,
        available: { engagements: ranges.length > 0, objectives: mine.length > 0 },
      };
      // Per-match kill counts are not recorded yet, so consistency stays unknown
      // rather than being invented from a lifetime total.
      return { row, stats, points: rankPoints(stats), perMatchKills: [] as number[] };
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
        consistency: consistency(entry.perMatchKills),
        timePlayedSeconds: entry.stats.activity.timePlayedSeconds,
      }));
  }

  /** What the population actually fights with. */
  async weapons(): Promise<WeaponRow[]> {
    const rows = await this.db
      .selectFrom("engagements")
      .select(["weapon_id", "shooter_id", "range_metres", "fatal", "headshot", "hit"])
      .execute();
    if (rows.length === 0) return [];

    const totalKills = rows.filter((row) => row.fatal === 1).length;
    const byWeapon = new Map<string, typeof rows>();
    for (const row of rows) {
      byWeapon.set(row.weapon_id, [...(byWeapon.get(row.weapon_id) ?? []), row]);
    }

    return [...byWeapon.entries()]
      .map(([weaponId, entries]) => {
        const kills = entries.filter((entry) => entry.fatal === 1).length;
        const headshots = entries.filter((entry) => entry.headshot === 1).length;
        const shots = entries.length;
        return {
          weaponId,
          kills,
          share: totalKills === 0 ? 0 : kills / totalKills,
          shots,
          shotsPerKill: kills === 0 ? null : shots / kills,
          headshots,
          headshotRate: kills === 0 ? null : headshots / kills,
          medianRangeMetres: median(
            entries.filter((entry) => entry.fatal === 1).map((entry) => entry.range_metres)
          ),
          users: new Set(entries.map((entry) => entry.shooter_id)).size,
        };
      })
      .sort((a, b) => b.kills - a.kills);
  }

  /** How each map actually plays. */
  async maps(): Promise<MapRow[]> {
    const [participation, engagements] = await Promise.all([
      this.db
        .selectFrom("match_participation")
        .select([
          "map",
          "match_id",
          "user_id",
          "joined_at",
          "left_at",
          "prone_ms",
          "moving_ms",
        ])
        .execute(),
      this.db
        .selectFrom("engagements")
        .innerJoin("match_participation", "match_participation.match_id", "engagements.match_id")
        .select(["match_participation.map", "engagements.range_metres", "engagements.fatal"])
        .execute(),
    ]);
    if (participation.length === 0) return [];

    const names = [...new Set(participation.map((row) => row.map))];
    return names
      .map((map) => {
        const rows = participation.filter((row) => row.map === map);
        const durations = rows.map(
          (row) => (Date.parse(row.left_at) - Date.parse(row.joined_at)) / 60000
        );
        const prone = rows.reduce((total, row) => total + row.prone_ms, 0);
        const moving = rows.reduce((total, row) => total + row.moving_ms, 0);
        return {
          map,
          matches: new Set(rows.map((row) => row.match_id)).size,
          players: new Set(rows.map((row) => row.user_id)).size,
          averageMatchMinutes:
            durations.length === 0
              ? null
              : durations.reduce((a, b) => a + b, 0) / durations.length,
          medianRangeMetres: median(
            engagements
              .filter((row) => row.map === map && row.fatal === 1)
              .map((row) => row.range_metres)
          ),
          proneShare: prone + moving === 0 ? null : prone / (prone + moving),
        };
      })
      .sort((a, b) => b.matches - a.matches);
  }
}
