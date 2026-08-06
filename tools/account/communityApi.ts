// Community routes: public profiles, the tagwall, friends, presence and clans.
//
// SERVER ONLY. Separate from api.ts because that router answers "what is my
// account" and this one answers "who knows whom" — different failure modes, and
// a wall's spam checks have no business beside the row mapping that decides what
// a password hash is allowed near.
//
// Every capability check reads the EFFECTIVE tier, and every rule is the one in
// src/account/community.ts that the client also runs. Design record:
// docs/plans/2026-08-04-community-layer-design.md.

import express, { type Request, type Response, type Router } from "express";
import { auth } from "@colyseus/auth";
import { effectiveTier } from "../../src/account/accountTypes.ts";
import { can } from "../../src/account/tiers.ts";
import {
  validateClanName,
  validateClanTag,
  validatePost,
} from "../../src/account/community.ts";
import {
  accountOf,
  optionalAccount,
  requireAccount,
  viewerOf,
} from "./authMiddleware.ts";
import { CommunityError, type CommunityRepository } from "./communityRepository.ts";
import type { AccountRepository } from "./repository.ts";

export interface CommunityApiDeps {
  accounts: AccountRepository;
  community: CommunityRepository;
  /**
   * Which account is in which room, right now.
   *
   * Injected rather than imported so this router does not reach into the game
   * server: presence is owned by the rooms, and the seam keeps the account layer
   * runnable without them (the tests mount it with an empty map).
   */
  presence: () => ReadonlyMap<number, string>;
}

/**
 * Refusals whose reason may be told to the caller.
 *
 * Everything else answers with its status and NO reason. The distinction is a
 * privacy one: `blocked` tells an author they were blocked, which is the fact
 * `friendState` deliberately hides by reporting "none" to a blocked viewer —
 * two halves of one product decision that disagreed. Rate-limit and validation
 * reasons are safe and useful, so those stay.
 */
const TELLABLE = new Set([
  "too_many",
  "too_many_here",
  "too_many_requests",
  "no_such_player",
  "no_such_post",
  "no_such_clan",
  "not_a_member",
  "not_in_clan",
  "already_in_clan",
  "already_leader",
  "tag_taken",
  "cannot_block_self",
  "cannot_friend_self",
  "clan_full",
]);

/** Map a repository refusal to a status, leaving anything else to Express. */
function fail(res: Response, error: unknown): void {
  if (error instanceof CommunityError) {
    const reason = TELLABLE.has(error.message) ? error.message : "refused";
    res.status(error.status).json({ error: reason });
    return;
  }
  throw error;
}

export function createCommunityRouter({
  accounts,
  community,
  presence,
}: CommunityApiDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "8kb" }));

  const authed = [auth.middleware(), requireAccount(accounts)];
  const maybe = optionalAccount(accounts);

  const idOf = (req: Request): number | null => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  /**
   * Everything a profile page renders, in ONE request.
   *
   * The page is a hub — identity, career, medals, clan, wall and activity — and
   * six round trips to draw one screen is how a profile page becomes slow enough
   * that nobody links to it. Optional auth: signed out sees the same page minus
   * the buttons.
   */
  router.get("/players/:id", maybe, async (req: Request, res: Response) => {
    const id = idOf(req);
    if (id === null) return void res.status(400).json({ error: "bad_id" });
    const profile = await accounts.publicProfile(id);
    if (profile === null) return void res.status(404).json({ error: "not_found" });

    const viewer = viewerOf(req);
    const [clan, wall, activity, sessionsByDay, stats, friendState] = await Promise.all([
      community.clanOf(id),
      community.wall(id),
      community.activity(id),
      community.sessionsByDay(id),
      community.playerStats(id),
      viewer === null
        ? Promise.resolve("none" as const)
        : community.friendState(viewer.id, id),
    ]);
    res.json({
      profile,
      clan,
      wall,
      activity,
      sessionsByDay,
      stats,
      viewer: {
        id: viewer?.id ?? null,
        friendState,
        isSelf: viewer !== null && viewer.id === id,
        // Whether the buttons should render at all, decided server-side so the
        // page cannot offer something the endpoint would refuse.
        canPost:
          viewer !== null &&
          can(effectiveTier(viewer.tier, viewer.tierExpiresAt, new Date()), "profilePosts"),
        canFriend:
          viewer !== null &&
          can(effectiveTier(viewer.tier, viewer.tierExpiresAt, new Date()), "friends"),
      },
    });
  });

  // --- tagwall -------------------------------------------------------------

  router.post("/players/:id/wall", authed, async (req: Request, res: Response) => {
    const id = idOf(req);
    if (id === null) return void res.status(400).json({ error: "bad_id" });
    const account = accountOf(req);
    const tier = effectiveTier(account.tier, account.tierExpiresAt, new Date());
    if (!can(tier, "profilePosts")) {
      return void res.status(403).json({ error: "needs_account" });
    }
    const body = (req.body as { body?: unknown }).body;
    const problem = validatePost(body);
    if (problem !== null) return void res.status(400).json({ error: problem.message });
    try {
      res.json({ post: await community.post(id, account.id, body as string) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/wall/:postId", authed, async (req: Request, res: Response) => {
    const postId = Number(req.params.postId);
    if (!Number.isInteger(postId) || postId <= 0) {
      return void res.status(400).json({ error: "bad_id" });
    }
    try {
      await community.deletePost(postId, accountOf(req).id);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- friends and blocking ------------------------------------------------

  router.post("/players/:id/friend", authed, async (req: Request, res: Response) => {
    const id = idOf(req);
    if (id === null) return void res.status(400).json({ error: "bad_id" });
    const account = accountOf(req);
    const tier = effectiveTier(account.tier, account.tierExpiresAt, new Date());
    if (!can(tier, "friends")) return void res.status(403).json({ error: "needs_account" });
    try {
      res.json({ state: await community.requestFriend(account.id, id) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/players/:id/friend/accept", authed, async (req: Request, res: Response) => {
    const id = idOf(req);
    if (id === null) return void res.status(400).json({ error: "bad_id" });
    const account = accountOf(req);
    // Gated like the request side. Without this a guest could not SEND a request
    // but could accept one, and `GET /friends` then handed them the friends-only
    // presence that `friends` is the capability for.
    const tier = effectiveTier(account.tier, account.tierExpiresAt, new Date());
    if (!can(tier, "friends")) return void res.status(403).json({ error: "needs_account" });
    try {
      await community.acceptFriend(account.id, id);
      res.json({ state: "friends" });
    } catch (error) {
      fail(res, error);
    }
  });

  /** One route for remove, withdraw and decline — they are the same edge going. */
  router.delete("/players/:id/friend", authed, async (req: Request, res: Response) => {
    const id = idOf(req);
    if (id === null) return void res.status(400).json({ error: "bad_id" });
    await community.removeFriendship(accountOf(req).id, id);
    res.json({ state: "none" });
  });

  router.post("/players/:id/block", authed, async (req: Request, res: Response) => {
    const id = idOf(req);
    if (id === null) return void res.status(400).json({ error: "bad_id" });
    try {
      await community.block(accountOf(req).id, id);
      res.json({ state: "blocked" });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/players/:id/block", authed, async (req: Request, res: Response) => {
    const id = idOf(req);
    if (id === null) return void res.status(400).json({ error: "bad_id" });
    await community.unblock(accountOf(req).id, id);
    res.json({ state: "none" });
  });

  /**
   * My friends, my pending requests, and which friends are in a game.
   *
   * Presence is attached HERE and nowhere else, because it is friends-only:
   * publishing which room a named player is in is a stalking primitive, and in a
   * game whose premise is concealment it is also a gameplay leak.
   */
  router.get("/friends", authed, async (req: Request, res: Response) => {
    const account = accountOf(req);
    // Same gate as request and accept: presence is what `friends` buys, so the
    // read has to check it too or the capability is enforced on two of three
    // routes and the third is the one that returns the data.
    const tier = effectiveTier(account.tier, account.tierExpiresAt, new Date());
    if (!can(tier, "friends")) return void res.status(403).json({ error: "needs_account" });
    const [friends, incoming] = await Promise.all([
      community.friends(account.id),
      community.incomingRequests(account.id),
    ]);
    const live = presence();
    res.json({
      friends: friends.map((friend) => {
        const roomId = live.get(friend.id);
        return roomId === undefined ? friend : { ...friend, roomId };
      }),
      incoming,
    });
  });

  // --- clans ---------------------------------------------------------------

  router.get("/clans", async (_req: Request, res: Response) => {
    res.json({ clans: await community.clans() });
  });

  router.get("/clans/:tag", async (req: Request, res: Response) => {
    const clan = await community.clanByTag(String(req.params.tag));
    if (clan === null) return void res.status(404).json({ error: "no_such_clan" });
    res.json({ clan });
  });

  /** Founding is the supporter perk. Joining, deliberately, is not. */
  router.post("/clans", authed, async (req: Request, res: Response) => {
    const account = accountOf(req);
    const tier = effectiveTier(account.tier, account.tierExpiresAt, new Date());
    if (!can(tier, "foundClan")) {
      return void res.status(403).json({ error: "needs_supporter" });
    }
    const { tag, name } = req.body as { tag?: unknown; name?: unknown };
    const problem = validateClanTag(tag) ?? validateClanName(name);
    if (problem !== null) return void res.status(400).json({ error: problem.message });
    try {
      res.json({ clan: await community.createClan(account.id, tag as string, name as string) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/clans/:tag/join", authed, async (req: Request, res: Response) => {
    try {
      await community.joinClan(accountOf(req).id, String(req.params.tag));
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Hand the clan to another member.
   *
   * The counterpart to leaving: leaving auto-promotes the longest-standing
   * member, this is how a leader CHOOSES their successor while staying in.
   */
  router.post("/clan/promote", authed, async (req: Request, res: Response) => {
    const memberId = Number((req.body as { memberId?: unknown }).memberId);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return void res.status(400).json({ error: "bad_id" });
    }
    try {
      await community.promoteClanMember(accountOf(req).id, memberId);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/clan/leave", authed, async (req: Request, res: Response) => {
    try {
      await community.leaveClan(accountOf(req).id);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
