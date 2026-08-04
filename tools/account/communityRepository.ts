// Every community query: tagwall, friends, blocks and clans.
//
// SERVER ONLY, and separate from repository.ts on the same line lobbyApi.ts is
// separate from api.ts — that file answers "what is an account", this one answers
// "who knows whom". They share a database and nothing else, and keeping the
// account's security-critical row mapping away from a wall's spam checks is worth
// one more file.
//
// Rules live in src/account/community.ts so the client validates with the same
// function; this file enforces them, which is the half that counts.

import { sql } from "kysely";
import {
  POSTS_PER_HOUR,
  POSTS_PER_WALL_PER_HOUR,
  OUTGOING_REQUESTS_MAX,
  normaliseClanName,
  normaliseClanTag,
  normalisePost,
  type ActivityEntry,
  type Clan,
  type ClanSummary,
  type Friend,
  type FriendState,
  type ProfilePost,
} from "../../src/account/community.ts";
import { medalById } from "../../src/account/medals.ts";
import {
  bandKills,
  median,
  type PlayerStats,
} from "../../src/account/playerStats.ts";
import type { AccountDb } from "./database.ts";

const nowIso = (): string => new Date().toISOString();
const hourAgoIso = (): string => new Date(Date.now() - 3_600_000).toISOString();

/** Thrown for a rule the caller broke. The API maps it to a 400/403. */
export class CommunityError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CommunityError";
    this.status = status;
  }
}

export class CommunityRepository {
  // An explicit field, not a constructor parameter property: Node runs this with
  // --experimental-strip-types, which rejects parameter properties outright.
  private readonly db: AccountDb;

  constructor(db: AccountDb) {
    this.db = db;
  }

  // --- tagwall -------------------------------------------------------------

  /** A wall, newest first. Public: anyone may read, including a signed-out visitor. */
  async wall(profileId: number, limit = 30): Promise<ProfilePost[]> {
    const rows = await this.db
      .selectFrom("profile_posts")
      .innerJoin("users", "users.id", "profile_posts.author_id")
      .select([
        "profile_posts.id",
        "profile_posts.body",
        "profile_posts.created_at",
        "users.id as author_id",
        "users.callsign",
        "users.tier",
      ])
      .where("profile_posts.profile_id", "=", profileId)
      .orderBy("profile_posts.created_at", "desc")
      .limit(Math.max(1, Math.min(100, limit)))
      .execute();
    return rows.map((row) => ({
      id: row.id,
      authorId: row.author_id,
      authorCallsign: row.callsign,
      authorTier: row.tier,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  /**
   * Leave a note on someone's wall.
   *
   * Three refusals, in the order that matters: a block is absolute and is checked
   * first so a blocked author cannot even learn whether they are rate limited;
   * then the per-wall limit, which is the harassment shape; then the global one,
   * which is the spam shape.
   */
  async post(profileId: number, authorId: number, body: string): Promise<ProfilePost> {
    const profile = await this.db
      .selectFrom("users")
      .select("id")
      .where("id", "=", profileId)
      .executeTakeFirst();
    if (profile === undefined) throw new CommunityError("no_such_player", 404);

    if (await this.isBlocked(profileId, authorId)) {
      throw new CommunityError("blocked", 403);
    }

    const since = hourAgoIso();
    if (authorId !== profileId) {
      const onThisWall = await this.countPosts(authorId, since, profileId);
      if (onThisWall >= POSTS_PER_WALL_PER_HOUR) {
        throw new CommunityError("too_many_here", 429);
      }
    }
    const total = await this.countPosts(authorId, since, null);
    if (total >= POSTS_PER_HOUR) throw new CommunityError("too_many", 429);

    const created = nowIso();
    const row = await this.db
      .insertInto("profile_posts")
      .values({
        profile_id: profileId,
        author_id: authorId,
        body: normalisePost(body),
        created_at: created,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const author = await this.db
      .selectFrom("users")
      .select(["callsign", "tier"])
      .where("id", "=", authorId)
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      authorId,
      authorCallsign: author.callsign,
      authorTier: author.tier,
      body: row.body,
      createdAt: row.created_at,
    };
  }

  /**
   * Remove a note.
   *
   * The wall's OWNER may delete anything on it, and an author may delete their
   * own note anywhere. Owner-delete is deliberate: a report queue as the only
   * remedy makes harassment the platform's problem to schedule rather than the
   * recipient's to end (design record §3.2).
   */
  async deletePost(postId: number, actorId: number): Promise<void> {
    const row = await this.db
      .selectFrom("profile_posts")
      .select(["profile_id", "author_id"])
      .where("id", "=", postId)
      .executeTakeFirst();
    if (row === undefined) throw new CommunityError("no_such_post", 404);
    if (row.profile_id !== actorId && row.author_id !== actorId) {
      throw new CommunityError("not_yours", 403);
    }
    await this.db.deleteFrom("profile_posts").where("id", "=", postId).execute();
  }

  private async countPosts(
    authorId: number,
    since: string,
    profileId: number | null
  ): Promise<number> {
    let query = this.db
      .selectFrom("profile_posts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("author_id", "=", authorId)
      .where("created_at", ">=", since);
    if (profileId !== null) query = query.where("profile_id", "=", profileId);
    const row = await query.executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  // --- blocking ------------------------------------------------------------

  async block(blockerId: number, blockedId: number): Promise<void> {
    if (blockerId === blockedId) throw new CommunityError("cannot_block_self");
    await this.db
      .insertInto("blocks")
      .values({ blocker_id: blockerId, blocked_id: blockedId, created_at: nowIso() })
      .onConflict((oc) => oc.columns(["blocker_id", "blocked_id"]).doNothing())
      .execute();
    // Blocking ends any friendship in either direction. Leaving the edge would
    // mean a blocked person still appears in the blocker's friends list.
    await this.removeFriendship(blockerId, blockedId);
  }

  async unblock(blockerId: number, blockedId: number): Promise<void> {
    await this.db
      .deleteFrom("blocks")
      .where("blocker_id", "=", blockerId)
      .where("blocked_id", "=", blockedId)
      .execute();
  }

  /** Has `profileId` blocked `otherId`? */
  private async isBlocked(profileId: number, otherId: number): Promise<boolean> {
    const row = await this.db
      .selectFrom("blocks")
      .select("blocker_id")
      .where("blocker_id", "=", profileId)
      .where("blocked_id", "=", otherId)
      .executeTakeFirst();
    return row !== undefined;
  }

  // --- friends -------------------------------------------------------------

  /**
   * Ask to be someone's friend.
   *
   * If they already asked you, this ACCEPTS instead of creating a mirrored
   * request — otherwise two people pressing the same button at the same time
   * would leave two pending edges that never resolve.
   */
  async requestFriend(requesterId: number, addresseeId: number): Promise<FriendState> {
    if (requesterId === addresseeId) throw new CommunityError("cannot_friend_self");
    const target = await this.db
      .selectFrom("users")
      .select("id")
      .where("id", "=", addresseeId)
      .executeTakeFirst();
    if (target === undefined) throw new CommunityError("no_such_player", 404);
    // A block in EITHER direction stops the request, and reports the same error
    // both ways so neither side learns which of them blocked the other.
    if (
      (await this.isBlocked(addresseeId, requesterId)) ||
      (await this.isBlocked(requesterId, addresseeId))
    ) {
      throw new CommunityError("blocked", 403);
    }

    const existing = await this.edge(requesterId, addresseeId);
    if (existing !== undefined) {
      if (existing.state === "accepted") return "friends";
      if (existing.addressee_id === requesterId) {
        await this.db
          .updateTable("friendships")
          .set({ state: "accepted", responded_at: nowIso() })
          .where("id", "=", existing.id)
          .execute();
        return "friends";
      }
      return "pending_out";
    }

    const outgoing = await this.db
      .selectFrom("friendships")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("requester_id", "=", requesterId)
      .where("state", "=", "pending")
      .executeTakeFirst();
    if (Number(outgoing?.count ?? 0) >= OUTGOING_REQUESTS_MAX) {
      throw new CommunityError("too_many_requests", 429);
    }

    await this.db
      .insertInto("friendships")
      .values({
        requester_id: requesterId,
        addressee_id: addresseeId,
        state: "pending",
        created_at: nowIso(),
        responded_at: null,
      })
      .execute();
    return "pending_out";
  }

  /** Accept a request that was made TO the actor. */
  async acceptFriend(actorId: number, otherId: number): Promise<void> {
    const edge = await this.edge(actorId, otherId);
    if (edge === undefined || edge.addressee_id !== actorId || edge.state !== "pending") {
      throw new CommunityError("no_such_request", 404);
    }
    await this.db
      .updateTable("friendships")
      .set({ state: "accepted", responded_at: nowIso() })
      .where("id", "=", edge.id)
      .execute();
  }

  /** Remove a friendship or withdraw/decline a request. One button, both jobs. */
  async removeFriendship(actorId: number, otherId: number): Promise<void> {
    await this.db
      .deleteFrom("friendships")
      .where((eb) =>
        eb.or([
          eb.and([eb("requester_id", "=", actorId), eb("addressee_id", "=", otherId)]),
          eb.and([eb("requester_id", "=", otherId), eb("addressee_id", "=", actorId)]),
        ])
      )
      .execute();
  }

  /** The relationship between two accounts, from `viewerId`'s side. */
  async friendState(viewerId: number, otherId: number): Promise<FriendState> {
    if (viewerId === otherId) return "none";
    if (await this.isBlocked(viewerId, otherId)) return "blocked";
    const edge = await this.edge(viewerId, otherId);
    if (edge === undefined) return "none";
    if (edge.state === "accepted") return "friends";
    return edge.requester_id === viewerId ? "pending_out" : "pending_in";
  }

  /** Accepted friends. */
  async friends(userId: number): Promise<Friend[]> {
    return await this.friendsWhere(userId, "accepted");
  }

  /** Requests waiting on this account to answer. */
  async incomingRequests(userId: number): Promise<Friend[]> {
    const rows = await this.db
      .selectFrom("friendships")
      .innerJoin("users", "users.id", "friendships.requester_id")
      .select(["users.id", "users.callsign", "users.tier"])
      .where("friendships.addressee_id", "=", userId)
      .where("friendships.state", "=", "pending")
      .orderBy("friendships.created_at", "desc")
      .execute();
    return rows.map((row) => ({ id: row.id, callsign: row.callsign, tier: row.tier }));
  }

  private async friendsWhere(userId: number, state: "accepted"): Promise<Friend[]> {
    // The edge is stored once, so "my friends" is a union over both columns.
    const rows = await this.db
      .selectFrom("friendships")
      .innerJoin("users", (join) =>
        join.onRef(
          "users.id",
          "=",
          sql<number>`case when friendships.requester_id = ${userId} then friendships.addressee_id else friendships.requester_id end`
        )
      )
      .select(["users.id", "users.callsign", "users.tier"])
      .where("friendships.state", "=", state)
      .where((eb) =>
        eb.or([eb("friendships.requester_id", "=", userId), eb("friendships.addressee_id", "=", userId)])
      )
      .orderBy("users.callsign", "asc")
      .execute();
    return rows.map((row) => ({ id: row.id, callsign: row.callsign, tier: row.tier }));
  }

  private async edge(a: number, b: number) {
    return await this.db
      .selectFrom("friendships")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([eb("requester_id", "=", a), eb("addressee_id", "=", b)]),
          eb.and([eb("requester_id", "=", b), eb("addressee_id", "=", a)]),
        ])
      )
      .executeTakeFirst();
  }

  // --- clans ---------------------------------------------------------------

  /**
   * Found a clan.
   *
   * The CAPABILITY check is the caller's job (the API does it) — this enforces
   * the rules that are the database's: one clan per founder, unique tag.
   */
  async createClan(founderId: number, tag: string, name: string): Promise<Clan> {
    const cleanTag = normaliseClanTag(tag);
    const cleanName = normaliseClanName(name);
    if (await this.clanOf(founderId)) throw new CommunityError("already_in_clan");
    const taken = await this.db
      .selectFrom("clans")
      .select("id")
      .where(sql`lower(tag)`, "=", cleanTag.toLowerCase())
      .executeTakeFirst();
    if (taken !== undefined) throw new CommunityError("tag_taken");

    const created = nowIso();
    const clan = await this.db
      .insertInto("clans")
      .values({ tag: cleanTag, name: cleanName, founder_id: founderId, created_at: created })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.db
      .insertInto("clan_members")
      .values({ clan_id: clan.id, user_id: founderId, role: "leader", joined_at: created })
      .execute();
    return (await this.clanByTag(cleanTag))!;
  }

  async clanByTag(tag: string): Promise<Clan | null> {
    const clan = await this.db
      .selectFrom("clans")
      .selectAll()
      .where(sql`lower(tag)`, "=", normaliseClanTag(tag).toLowerCase())
      .executeTakeFirst();
    if (clan === undefined) return null;
    const members = await this.db
      .selectFrom("clan_members")
      .innerJoin("users", "users.id", "clan_members.user_id")
      .select(["users.id", "users.callsign", "users.tier", "clan_members.role", "clan_members.joined_at"])
      .where("clan_members.clan_id", "=", clan.id)
      .orderBy("clan_members.joined_at", "asc")
      .execute();
    return {
      id: clan.id,
      tag: clan.tag,
      name: clan.name,
      founderId: clan.founder_id,
      createdAt: clan.created_at,
      memberCount: members.length,
      members: members.map((row) => ({
        id: row.id,
        callsign: row.callsign,
        tier: row.tier,
        role: row.role,
        joinedAt: row.joined_at,
      })),
    };
  }

  /** The clan a player belongs to, for the tag beside their name. */
  async clanOf(userId: number): Promise<ClanSummary | null> {
    const row = await this.db
      .selectFrom("clan_members")
      .innerJoin("clans", "clans.id", "clan_members.clan_id")
      .select(["clans.id", "clans.tag", "clans.name"])
      .where("clan_members.user_id", "=", userId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const count = await this.db
      .selectFrom("clan_members")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("clan_id", "=", row.id)
      .executeTakeFirst();
    return { id: row.id, tag: row.tag, name: row.name, memberCount: Number(count?.count ?? 0) };
  }

  async joinClan(userId: number, tag: string): Promise<void> {
    if (await this.clanOf(userId)) throw new CommunityError("already_in_clan");
    const clan = await this.db
      .selectFrom("clans")
      .select("id")
      .where(sql`lower(tag)`, "=", normaliseClanTag(tag).toLowerCase())
      .executeTakeFirst();
    if (clan === undefined) throw new CommunityError("no_such_clan", 404);
    await this.db
      .insertInto("clan_members")
      .values({ clan_id: clan.id, user_id: userId, role: "member", joined_at: nowIso() })
      .execute();
  }

  /**
   * Leave a clan.
   *
   * The last leader cannot walk out of a clan that still has members — that
   * would leave a clan nobody can administer and a tag nobody can release.
   */
  async leaveClan(userId: number): Promise<void> {
    const membership = await this.db
      .selectFrom("clan_members")
      .selectAll()
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (membership === undefined) throw new CommunityError("not_in_clan");
    if (membership.role === "leader") {
      const others = await this.db
        .selectFrom("clan_members")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("clan_id", "=", membership.clan_id)
        .where("user_id", "!=", userId)
        .executeTakeFirst();
      if (Number(others?.count ?? 0) > 0) throw new CommunityError("promote_first");
      // Last member out disbands it, so a tag is never orphaned.
      await this.db.deleteFrom("clans").where("id", "=", membership.clan_id).execute();
      return;
    }
    await this.db
      .deleteFrom("clan_members")
      .where("clan_id", "=", membership.clan_id)
      .where("user_id", "=", userId)
      .execute();
  }

  async clans(limit = 50): Promise<ClanSummary[]> {
    const rows = await this.db
      .selectFrom("clans")
      .leftJoin("clan_members", "clan_members.clan_id", "clans.id")
      .select(({ fn }) => [
        "clans.id",
        "clans.tag",
        "clans.name",
        fn.count<number>("clan_members.user_id").as("member_count"),
      ])
      .groupBy(["clans.id", "clans.tag", "clans.name"])
      .orderBy("member_count", "desc")
      .limit(Math.max(1, Math.min(100, limit)))
      .execute();
    return rows.map((row) => ({
      id: row.id,
      tag: row.tag,
      name: row.name,
      memberCount: Number(row.member_count),
    }));
  }

  /**
   * Sessions per day for the last `days` days, oldest first.
   *
   * Returned as a dense array including zero days, because a sparkline of only
   * the days someone played is a lie about their rhythm — the gaps ARE the
   * shape. Bucketed by UTC date, which is what the stored ISO strings are in.
   */
  async sessionsByDay(userId: number, days = 30): Promise<number[]> {
    const since = new Date(Date.now() - (days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const rows = await this.db
      .selectFrom("sessions")
      .select(["ended_at"])
      .where("user_id", "=", userId)
      .where("ended_at", ">=", since.toISOString())
      .execute();

    const counts = new Map<string, number>();
    for (const row of rows) {
      const day = row.ended_at.slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return Array.from({ length: days }, (_unused, index) => {
      const day = new Date(since.getTime() + index * 86_400_000).toISOString().slice(0, 10);
      return counts.get(day) ?? 0;
    });
  }

  /**
   * Everything a stats page needs, assembled from the telemetry tables.
   *
   * `available` is the load-bearing part. Until the authority layer on
   * feat/server-ballistics writes `engagements`, every range, headshot and
   * accuracy figure is genuinely unknown — and unknown must not render as zero,
   * because a zeroed kills table is a claim that nobody has killed anyone. The
   * page draws those sections as a labelled frame instead, and fills in on its
   * own the day rows start arriving.
   */
  async playerStats(userId: number): Promise<PlayerStats> {
    const [career, participation, engagementRows] = await Promise.all([
      this.db.selectFrom("career").selectAll().where("user_id", "=", userId).executeTakeFirst(),
      this.db
        .selectFrom("match_participation")
        .selectAll()
        .where("user_id", "=", userId)
        .execute(),
      this.db
        .selectFrom("engagements")
        .select(["range_metres", "fatal", "headshot", "hit", "first_of_engagement"])
        .where("shooter_id", "=", userId)
        .execute(),
    ]);

    const users = await this.db
      .selectFrom("users")
      .select(["created_at", "last_seen_at"])
      .where("id", "=", userId)
      .executeTakeFirst();

    const sum = (pick: (row: (typeof participation)[number]) => number): number =>
      participation.reduce((total, row) => total + pick(row), 0);

    const fatalRanges = engagementRows
      .filter((row) => row.fatal === 1)
      .map((row) => row.range_metres);
    const firstShots = engagementRows.filter((row) => row.first_of_engagement === 1);

    return {
      combat: {
        kills: career?.kills ?? 0,
        deaths: career?.deaths ?? 0,
        headshots: engagementRows.filter((row) => row.headshot === 1).length,
        shotsFired: sum((row) => row.shots_fired),
        // Weapon breakdown needs the weapon column, which only `engagements`
        // carries — so these stay zero and `available.engagements` says why.
        sniperKills: 0,
        pistolKills: 0,
        knifeKills: 0,
        suicides: 0,
        teamKills: 0,
        bestStreak: participation.reduce((best, row) => Math.max(best, row.best_streak), 0),
        longestShotMetres: career?.longest_shot_metres ?? 0,
      },
      activity: {
        matches: career?.matches ?? 0,
        timePlayedSeconds: career?.time_played_seconds ?? 0,
        firstSeen: users?.created_at ?? null,
        lastSeen: users?.last_seen_at ?? null,
        wins: participation.filter((row) => row.result === "win").length,
        losses: participation.filter((row) => row.result === "loss").length,
        draws: participation.filter((row) => row.result === "draw").length,
        firstBloods: 0,
        proneMs: sum((row) => row.prone_ms),
        movingMs: sum((row) => row.moving_ms),
        concealedMs: sum((row) => row.concealed_ms),
      },
      ranges: bandKills(fatalRanges),
      medianRangeMetres: median(fatalRanges),
      firstRoundHitRate:
        firstShots.length === 0
          ? null
          : firstShots.filter((row) => row.hit === 1).length / firstShots.length,
      available: {
        engagements: engagementRows.length > 0,
        objectives: participation.length > 0,
      },
    };
  }

  // --- activity ------------------------------------------------------------

  /**
   * A player's recent activity, DERIVED from the tables that already hold it.
   *
   * No `activity` table: every entry below duplicates a fact with a home, and a
   * duplicated fact is one that can disagree with itself (design record §3.5).
   * Three small indexed reads merged in memory beats a write path on every event.
   */
  async activity(userId: number, limit = 12): Promise<ActivityEntry[]> {
    const [medals, posts, membership] = await Promise.all([
      this.db
        .selectFrom("medals")
        .select(["medal_id", "awarded_at"])
        .where("user_id", "=", userId)
        .orderBy("awarded_at", "desc")
        .limit(limit)
        .execute(),
      this.db
        .selectFrom("profile_posts")
        .innerJoin("users", "users.id", "profile_posts.profile_id")
        .select(["users.callsign", "profile_posts.created_at", "profile_posts.profile_id"])
        .where("profile_posts.author_id", "=", userId)
        .orderBy("profile_posts.created_at", "desc")
        .limit(limit)
        .execute(),
      this.db
        .selectFrom("clan_members")
        .innerJoin("clans", "clans.id", "clan_members.clan_id")
        .select(["clans.tag", "clans.name", "clan_members.joined_at"])
        .where("clan_members.user_id", "=", userId)
        .executeTakeFirst(),
    ]);

    const entries: ActivityEntry[] = [
      ...medals.map((row) => ({
        kind: "medal" as const,
        at: row.awarded_at,
        text: `Earned ${medalById(row.medal_id)?.name ?? row.medal_id}`,
      })),
      ...posts.map((row) => ({
        kind: "post" as const,
        at: row.created_at,
        text:
          row.profile_id === userId
            ? "Posted on their own wall"
            : `Wrote on ${row.callsign}'s wall`,
      })),
      ...(membership !== undefined
        ? [
            {
              kind: "clan" as const,
              at: membership.joined_at,
              text: `Joined [${membership.tag}] ${membership.name}`,
            },
          ]
        : []),
    ];
    return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
}
