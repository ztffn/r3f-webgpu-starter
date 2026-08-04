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
import { matchMaker } from "@colyseus/core";
import { normaliseJoinCode, type ServerListing } from "../../src/account/lobby.ts";
import { GAME_ROOM } from "../../src/net/ColyseusProtocol.ts";
import { LEADERBOARD_COLUMNS, type AccountRepository } from "./repository.ts";
import type { RoomMetadata } from "./roomMetadata.ts";

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
      res.status(503).json({ error: "matchmaker_unavailable", detail: String(error) });
    }
  });

  /**
   * Resolve a join code to a room id.
   *
   * Codes are compared case-insensitively because they get read aloud and typed
   * from memory. A wrong code returns 404 with nothing else — no hint about
   * whether a room exists, since the code IS the access control.
   */
  router.post("/join-code", async (req: Request, res: Response) => {
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
      res.status(503).json({ error: "matchmaker_unavailable", detail: String(error) });
    }
  });

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
    const entry = LEADERBOARD_COLUMNS[board];
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
