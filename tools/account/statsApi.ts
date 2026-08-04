// Population statistics routes: the board, weapons, maps and head-to-head.
//
// SERVER ONLY, and public — a leaderboard nobody can read without an account is
// a leaderboard nobody links to. Separate from communityApi.ts because these read
// across every account rather than about one, and a slow population aggregate
// must not be able to make a profile slow.

import express, { type Request, type Response, type Router } from "express";
import type { CommunityRepository } from "./communityRepository.ts";
import type { StatsRepository } from "./statsRepository.ts";
import type { AccountRepository } from "./repository.ts";

export interface StatsApiDeps {
  accounts: AccountRepository;
  community: CommunityRepository;
  stats: StatsRepository;
}

export function createStatsRouter({ accounts, community, stats }: StatsApiDeps): Router {
  const router = express.Router();

  router.get("/stats/leaderboard", async (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ entries: await stats.leaderboard(Number.isFinite(limit) ? limit : 50) });
  });

  router.get("/stats/weapons", async (_req: Request, res: Response) => {
    res.json({ weapons: await stats.weapons() });
  });

  router.get("/stats/maps", async (_req: Request, res: Response) => {
    res.json({ maps: await stats.maps() });
  });

  /**
   * Two players, side by side.
   *
   * Both profiles are fetched in parallel and returned whole rather than diffed
   * server-side: the page decides which figures to compare, and a server that
   * pre-computed the diff would have to be edited every time the page adds a row.
   */
  router.get("/stats/compare", async (req: Request, res: Response) => {
    const parse = (value: unknown): number | null => {
      const id = Number(value);
      return Number.isInteger(id) && id > 0 ? id : null;
    };
    const a = parse(req.query.a);
    const b = parse(req.query.b);
    if (a === null || b === null) return void res.status(400).json({ error: "bad_ids" });
    if (a === b) return void res.status(400).json({ error: "same_player" });

    const [profileA, profileB, statsA, statsB] = await Promise.all([
      accounts.publicProfile(a),
      accounts.publicProfile(b),
      community.playerStats(a),
      community.playerStats(b),
    ]);
    if (profileA === null || profileB === null) {
      return void res.status(404).json({ error: "not_found" });
    }
    res.json({ a: { profile: profileA, stats: statsA }, b: { profile: profileB, stats: statsB } });
  });

  /** Who is on the site, so a compare page can offer names to pick. */
  router.get("/stats/players", async (_req: Request, res: Response) => {
    res.json({ players: (await stats.leaderboard(200)).map((entry) => ({
      id: entry.id,
      callsign: entry.callsign,
    })) });
  });

  return router;
}
