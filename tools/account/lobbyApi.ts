// Lobby, server browser and leaderboard routes.
//
// SERVER ONLY. Separate from api.ts because these read the MATCHMAKER rather than
// the database — the two have different failure modes, and a browser that lists
// rooms should not be able to take the account API down with it.
//
// The listing is built here rather than by letting the client call Colyseus's own
// matchmaking endpoint, for one reason that matters: a private room's join code
// lives in its metadata, and the server is the only place that can see the
// metadata without publishing it. Filtering happens before the response, not in
// the client.

import express, { type Request, type Response, type Router } from "express";
import { auth } from "@colyseus/auth";
import { matchMaker } from "@colyseus/core";
import { effectiveTier } from "../../src/account/accountTypes.ts";
import { normaliseJoinCode, type ServerListing } from "../../src/account/lobby.ts";
import { can } from "../../src/account/tiers.ts";
import { GAME_ROOM } from "../../src/net/ColyseusProtocol.ts";
import { accountOf, requireAccount } from "./authMiddleware.ts";
import {
  LEADERBOARD_COLUMNS,
  leaderboardDefinition,
  type AccountRepository,
} from "./repository.ts";
import { readRoomOptions, type RoomMetadata } from "./roomMetadata.ts";

export interface LobbyApiDeps {
  repository: AccountRepository;
}

export function createLobbyRouter({ repository }: LobbyApiDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "4kb" }));

  /**
   * Public rooms.
   *
   * Private rooms are omitted entirely rather than listed as "private": a listing
   * that shows a private match exists, with its player count, leaks the thing the
   * host chose privacy for. They are reachable only through /join-code below.
   */
  router.get("/servers", async (req: Request, res: Response) => {
    const inputClass = typeof req.query.input === "string" ? req.query.input : null;
    try {
      const rooms = await matchMaker.query({ name: GAME_ROOM });
      const listings: ServerListing[] = rooms
        .filter((room) => room.private !== true && room.unlisted !== true)
        .map((room) => {
          const meta = (room.metadata ?? {}) as Partial<RoomMetadata>;
          return {
            roomId: room.roomId,
            label: meta.label ?? "Unnamed",
            map: meta.map ?? "unknown",
            weather: meta.weather ?? "unknown",
            inputClass: meta.inputClass ?? "desktop",
            players: room.clients,
            maxPlayers: room.maxClients,
            community: meta.community === true,
            hostCallsign: meta.hostCallsign ?? null,
            locked: room.locked === true,
          };
        })
        // No cross-play: the filter is applied server-side so a client cannot
        // simply ask for the other queue. It is a MATCHMAKING filter, though, and
        // a client claim — not a trust boundary (design record 2.5).
        .filter((listing) => inputClass === null || listing.inputClass === inputClass)
        .sort((a, b) => b.players - a.players || a.label.localeCompare(b.label));
      res.json({ servers: listings });
    } catch (error) {
      // The matchmaker being unavailable is not the account API's problem, and a
      // 503 with a reason beats an empty list that looks like "no servers".
      fail(res, error);
    }
  });

  /**
   * Resolve a join code to a room id.
   *
   * Codes are compared case-insensitively because they get read aloud and typed
   * from memory. A wrong code returns 404 with nothing else — no hint about
   * whether a room exists, since the code IS the access control.
   */
  router.post(
    "/join-code",
    // AUTHENTICATED, because `joinPrivateGame` is an enlisted capability that
    // nothing checked — the endpoint was open, so an advertised perk was
    // enforced nowhere. It is also what makes a code-guessing sweep attributable
    // to an account rather than to nobody.
    [auth.middleware(), requireAccount(repository)],
    async (req: Request, res: Response) => {
      const account = accountOf(req);
      const tier = effectiveTier(account.tier, account.tierExpiresAt, new Date());
      if (!can(tier, "joinPrivateGame")) {
        return void res.status(403).json({ error: "register_to_join_private_games" });
      }
      const raw = (req.body as { code?: unknown }).code;
      if (typeof raw !== "string" || raw.trim() === "") {
        return void res.status(400).json({ error: "code_required" });
      }
      const code = normaliseJoinCode(raw);
      try {
        const rooms = await matchMaker.query({ name: GAME_ROOM });
        const match = rooms.find(
          (room) => ((room.metadata ?? {}) as Partial<RoomMetadata>).joinCode === code
        );
        if (match === undefined) return void res.status(404).json({ error: "no_such_game" });
        if (match.clients >= match.maxClients) {
          return void res.status(409).json({ error: "game_full" });
        }
        res.json({ roomId: match.roomId });
      } catch (error) {
        fail(res, error);
      }
    }
  );

  /**
   * Host a private game.
   *
   * The room is created HERE, server-side, because `hostPrivateGame` is a
   * supporter capability and this is the only layer that knows who the caller
   * is. It used to be a client option — `?private=1` reached `onCreate`, which
   * honoured `visibility: "private"` from untrusted room options — so an
   * advertised paid perk was enforced by nothing but a hidden button.
   *
   * Mirrors /join-code deliberately: resolve on the server, hand the client a
   * room id, and let it navigate to /play with `&room=`. The game module still
   * knows nothing about tiers or about a lobby.
   *
   * **Residual limitation, stated rather than papered over:** a hand-rolled
   * Colyseus client can still pass `visibility: "private"` to `joinOrCreate` and
   * get a private room. Sealing that needs room-scope authentication, which
   * phase 6 deliberately left optional so every documented dev URL keeps working
   * (design record §5.4). This closes the product surface, not the protocol.
   */
  router.post(
    "/private-game",
    [auth.middleware(), requireAccount(repository)],
    async (req: Request, res: Response) => {
      const account = accountOf(req);
      const tier = effectiveTier(account.tier, account.tierExpiresAt, new Date());
      if (!can(tier, "hostPrivateGame")) {
        return void res.status(403).json({ error: "needs_supporter" });
      }
      // The same clamping the room applies, run here so a label that the room
      // would reject cannot reach the matchmaker either.
      const { inputClass, label } = readRoomOptions(req.body as Record<string, unknown>);
      try {
        const room = await matchMaker.createRoom(GAME_ROOM, {
          visibility: "private",
          inputClass,
          ...(label !== null ? { label } : {}),
        });
        // The code is NOT returned. It reaches the host the way it reaches
        // everyone else — the ROOM_INFO message on join — so there is one path
        // for it and it never lands in a fetch response someone might log.
        res.json({ roomId: room.roomId });
      } catch (error) {
        fail(res, error);
      }
    }
  );

  /**
   * A leaderboard.
   *
   * `board` is looked up in a table rather than used as a column name, so nothing
   * from the request reaches the query. Every board is currently readable and
   * mostly empty: matches and time played are recorded when a session ends, and
   * kills stay at zero until the authority work lands. The response says which,
   * so the page can explain an empty table instead of looking broken.
   */
  router.get("/leaderboard/:board", async (req: Request, res: Response) => {
    const board = typeof req.params.board === "string" ? req.params.board : "";
    const entry = leaderboardDefinition(board);
    if (entry === undefined) {
      return void res.status(404).json({
        error: "no_such_board",
        boards: Object.keys(LEADERBOARD_COLUMNS),
      });
    }
    const limit = Number(req.query.limit ?? 25);
    res.json({
      board,
      label: entry.label,
      // Unit and `populated` are read from the table rather than decided here, so
      // adding a board is one entry in one place. `populated` is what lets the
      // page be honest about a blank table instead of implying nobody has played.
      unit: entry.unit,
      populated: entry.populated,
      rows: await repository.leaderboard(entry.column, Number.isFinite(limit) ? limit : 25),
    });
  });

  /** Which boards exist, so the page does not hardcode the list. */
  router.get("/leaderboards", (_req: Request, res: Response) => {
    res.json({
      boards: Object.entries(LEADERBOARD_COLUMNS).map(([id, entry]) => ({
        id,
        label: entry.label,
        unit: entry.unit,
        populated: entry.populated,
      })),
    });
  });

  return router;
}

/**
 * The matchmaker is unavailable, and the client learns only that.
 *
 * A 503 with a reason beats an empty list that reads as "no servers" — but the
 * reason is a CATEGORY, never `String(error)`: that text is the matchmaker's own
 * message and on some failures carries a stack. The operator still gets all of
 * it, in the log.
 */
function fail(res: Response, error: unknown): void {
  console.error("[accounts] matchmaker request failed:", error);
  res.status(503).json({ error: "matchmaker_unavailable" });
}
