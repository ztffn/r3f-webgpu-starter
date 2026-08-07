// Authoritative Colyseus game server on the real prepared terrain.
//
// Colyseus owns rooms, matchmaking and connection lifecycle; each GameRoom
// bridges its clients onto the transport seam and hosts one untouched
// GameServer, so the simulation, codec and command-queue behaviour are the
// exact code the loopback tests drive. The hot path is raw bytes both ways
// (patchRate null, no Schema state), per the 2026-08-03 adoption record.
//
// Run: npm run game:server   (or: node --experimental-strip-types
//        --experimental-specifier-resolution=node tools/game-server/server.ts [port])
//
// Weather is the room's, not the client's: DF2_WEATHER=<preset id> picks one for
// every room, =random gives each room its own, =rotate cycles it every minute.
// DF2_ADMIN=1 additionally lets any connected client dial the room's visuals for
// everyone — a development flag, never a public one.

import { Room, Server, type Client } from "@colyseus/core";
import { JWT } from "@colyseus/auth";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameServer } from "../../src/net/GameServer.ts";
import {
  COMMANDS_UP,
  GAME_ROOM,
  PACKET_DOWN,
  ROOM_INFO,
  type RoomInfo,
} from "../../src/net/ColyseusProtocol.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import { DEFAULT_MOTOR_TUNING } from "../../src/motor/MotorTypes.ts";
import type { ServerConnection, ServerTransport } from "../../src/net/Transport.ts";
import { TERRAIN_SLUG, isAssetSlug } from "../../src/df2/config.ts";
import { WEATHER_PRESET_IDS, weatherPresetIndex } from "../../src/df2/weather.ts";
import { clampVisualDial } from "../../src/df2/visualDials.ts";
import { loadServerTerrain } from "./terrain.ts";
import { mountAccounts, type MountedAccounts } from "../account/mount.ts";
import { accountFromToken } from "../account/authSettings.ts";
import {
  makeJoinCode,
  readRoomOptions,
  type RoomMetadata,
  type RoomOptions,
} from "../account/roomMetadata.ts";

const PORT = Number(process.argv[2] ?? 2567);
const PATCH_HZ = 20;

/**
 * `DF2_WEATHER` — a preset id, `random` for one per room, or `rotate` to cycle.
 * Defaults to the neutral daylight preset, so nothing changes visually unless it
 * is asked for.
 *
 * An env var rather than argv because `npm run game:server` already owns argv[2]
 * for the port and `npm run x -- 2567 moody` reads worse than a named variable.
 *
 * `rotate` exists so the CHANGE half of replication is verifiable by looking at
 * it: with a fixed preset the join path is all a live session can exercise, and
 * "the sky changed in both windows at the same moment" is the only check that
 * proves a change reaches an already-connected client.
 */
const WEATHER = process.env.DF2_WEATHER ?? "day";
const WEATHER_RANDOM = WEATHER === "random";
const WEATHER_ROTATE = WEATHER === "rotate";
const ROTATE_SECONDS = 60;
/** Resolved once, so the startup banner is a flat interpolation rather than nested. */
const WEATHER_LABEL = WEATHER_ROTATE
  ? `rotating every ${ROTATE_SECONDS}s`
  : WEATHER_RANDOM
    ? "random per room"
    : WEATHER;
if (!WEATHER_RANDOM && !WEATHER_ROTATE && !WEATHER_PRESET_IDS.includes(WEATHER)) {
  // A silent fallback to daylight after a typo is an hour spent wondering why
  // the sky did not change. Say it, then carry on with the neutral preset.
  console.warn(
    `unknown DF2_WEATHER "${WEATHER}" — using day. ` +
      `known: random, rotate, ${WEATHER_PRESET_IDS.join(", ")}`
  );
}

/**
 * `DF2_ADMIN=1` — let connected clients dial this server's rooms for everyone.
 *
 * A DEVELOPMENT FLAG, off by default and deliberately blunt: with it set, every
 * client in the room is an admin. That is the right shape for tuning visuals with
 * two windows open on one machine and the wrong shape for anything reachable by
 * someone else, because the fog an admin can lift is the concealment the game is
 * built on. A real credential belongs behind this same gate when there is a reason
 * for one; nothing above the gate changes when it arrives.
 */
const ADMIN = process.env.DF2_ADMIN === "1";

/** Per ROOM, so `random` means each match has its own sky rather than the process. */
function pickWeatherIndex(): number {
  return WEATHER_RANDOM || WEATHER_ROTATE
    ? Math.floor(Math.random() * WEATHER_PRESET_IDS.length)
    : weatherPresetIndex(WEATHER);
}

/**
 * Most seconds one session may credit to a career. Six hours.
 *
 * A cap and not a measurement: the session length is wall-clock between join and
 * leave, with no idle detection, and "Time played" is one of only two leaderboards
 * that anything writes. Uncapped, a socket parked in a room outranks somebody who
 * actually plays, and it does so while asleep. Six hours is longer than any real
 * sitting and short enough that a forgotten tab cannot climb the board overnight.
 *
 * The honest fix is to count time the player is actually issuing commands, which
 * needs a signal the room does not track yet.
 */
const MAX_SESSION_SECONDS = 6 * 3600;

// `DF2_MAP=egypt` serves a different prepared terrain; the default stays gmile.
// Checked with the same slug rule as the client's `?map=` (the raw env value
// reaches join(assetRoot, slug), so it must never carry path segments) — but
// REFUSED rather than silently defaulted, like the missing-JWT_SECRET case: an
// operator who typed DF2_MAP=EGYPT was silently serving gmile while telling
// players to join with ?map=egypt, and every one of them desynced.
const MAP_REQUESTED = process.env.DF2_MAP || undefined;
if (MAP_REQUESTED !== undefined && !isAssetSlug(MAP_REQUESTED)) {
  throw new Error(
    `DF2_MAP "${MAP_REQUESTED}" is not a valid map slug (lowercase a-z, 0-9, _ or -, ` +
      `max 32 chars). Refusing to start rather than silently serving "${TERRAIN_SLUG}".`
  );
}
const MAP_SLUG = MAP_REQUESTED ?? TERRAIN_SLUG;
const RAPIER = await initRapier();
const terrain = loadServerTerrain(MAP_SLUG);
const tickMs = DEFAULT_MOTOR_TUNING.fixedTimestepSeconds * 1000;
/**
 * The whole tile: the client walks an endlessly tiling map, the server's
 * static collider has real edges, so cover exactly one period of it.
 *
 * DERIVED from the loaded map, not a constant. The literal 2048 it replaces
 * was the pre-calibration tile size; after the 1 m/texel calibration the tile
 * is 1024 m, and the stale constant quietly built a collider over 2x2 map
 * periods — a 4097² height grid (~67 MB plus Rapier's copy) sampling 16.8
 * million points at every server start, where one period describes the same
 * ground at a quarter of that.
 */
const SURFACE_SPAN_METRES = terrain.worldSize;

/** Per-room adapter from Colyseus callbacks onto the project transport seam. */
class RoomBridge implements ServerTransport {
  connectionHandler: ((connection: ServerConnection) => void) | null = null;
  messageHandler: ((connection: ServerConnection, bytes: Uint8Array) => void) | null = null;
  disconnectionHandler: ((connection: ServerConnection) => void) | null = null;

  onConnection(handler: (connection: ServerConnection) => void): void {
    this.connectionHandler = handler;
  }
  onMessage(handler: (connection: ServerConnection, bytes: Uint8Array) => void): void {
    this.messageHandler = handler;
  }
  onDisconnection(handler: (connection: ServerConnection) => void): void {
    this.disconnectionHandler = handler;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class GameRoom extends Room {
  maxClients = 64;
  patchRate = null;

  /**
   * How long a room survives with nobody in it, and how long a reserved seat is
   * held. Colyseus's default is 15 seconds.
   *
   * Raised because `POST /api/private-game` creates the room BEFORE the host has
   * loaded the game: the browser then navigates to /play, which lazy-loads a
   * ~930 kB GameApp chunk, ~390 kB of three, Rapier and the terrain before it can
   * call `joinById`. On a cold cache that is comfortably more than 15 seconds, and
   * the room the host was just handed had already auto-disposed — "no such room"
   * from a game they created a moment ago.
   *
   * Assigned as a subclass FIELD on purpose. Colyseus arms the first auto-dispose
   * timer inside `__init()`, which runs after the constructor and before
   * `onCreate`, so a field initialiser is the last point that can still change the
   * value it reads; setting it in `onCreate` would be too late, and
   * `resetAutoDisposeTimeout` is private to the base class.
   *
   * The cost is that an empty room lingers this long before disposing, and that an
   * abandoned seat reservation holds its slot for the same time. Both are cheap
   * next to handing someone a room id that has already stopped existing.
   */
  seatReservationTimeout = 45;

  private readonly bridge = new RoomBridge();
  private readonly connections = new Map<string, ServerConnection>();
  /** sessionId -> the account behind it, and when it joined. */
  private readonly sessions = new Map<
    string,
    { accountId: number | null; joinedAtMs: number }
  >();
  // Starts at 0 because the allocator in onJoin pre-increments; the wrap-around
  // it performs is what keeps connection ids out of the world-target id band.
  private nextId = 0;
  private game!: GameServer;

  /**
   * Resolve the caller's token to an account, or let them in as nobody.
   *
   * OPTIONAL BY DESIGN. Returning a value for an absent or bad token rather than
   * rejecting keeps every documented dev URL working — `?scene=scope&motor=1&net=1`
   * has never carried a token and must not start failing. What identity buys is
   * career recording, so an anonymous joiner simply is not recorded.
   *
   * This is emphatically NOT a trust boundary for gameplay: it says who someone
   * claims to be for the purpose of writing their own stats. Anti-cheat is
   * elsewhere and unbuilt.
   */
  static async onAuth(token: string): Promise<{ accountId: number | null }> {
    if (typeof token !== "string" || token === "") return { accountId: null };
    try {
      const payload = await JWT.verify(token);
      const account = await accountFromToken(accounts.repository, payload);
      return { accountId: account?.id ?? null };
    } catch {
      // A stale or forged token joins as nobody rather than being refused. The
      // player still gets to play; they just do not get credited.
      return { accountId: null };
    }
  }

  onCreate(options: RoomOptions): void {
    const { isPrivate, inputClass, label } = readRoomOptions(options);
    const weatherIndex = pickWeatherIndex();
    this.game = new GameServer(RAPIER, createMotorWorld(RAPIER), terrain, this.bridge, {
      sharedSurfaceSpanMetres: SURFACE_SPAN_METRES,
      patchHz: PATCH_HZ,
      weatherIndex,
      clampVisualDial,
      allowClientVisualDials: ADMIN,
      // A shared target ladder out from the spawn ring, SERVER-authored so
      // every player shoots the same figures and sees the same husks. Ranges
      // echo the offline contrast ladder; feet land on the real terrain.
      worldTargets: [
        { x: 4, z: -15 },
        { x: -6, z: -35 },
        { x: 8, z: -70 },
        { x: -10, z: -140 },
        { x: 3, z: -300 },
      ],
    });
    // A private room is excluded from matchmaking and from the browser by
    // Colyseus itself; the code is how it is reachable at all. Generated here so
    // it exists before the first client can ask for it.
    const joinCode = isPrivate ? makeJoinCode() : undefined;
    if (isPrivate) this.setPrivate(true);
    this.metadata = {
      label: label ?? `${MAP_SLUG} — ${isPrivate ? "private" : "public"}`,
      map: MAP_SLUG,
      weather: WEATHER_PRESET_IDS[weatherIndex]!,
      inputClass,
      community: false,
      hostCallsign: null,
      joinCode,
    } satisfies RoomMetadata;

    console.log(
      `[${this.roomId}] weather: ${WEATHER_PRESET_IDS[weatherIndex]}` +
        `, ${inputClass}${joinCode !== undefined ? `, private code ${joinCode}` : ""}`
    );
    if (WEATHER_ROTATE) {
      // The room clock, like the telemetry interval below, so a disposed room
      // does not keep changing the weather of a match that no longer exists.
      this.clock.setInterval(() => {
        const next = (this.game.weatherIndex + 1) % WEATHER_PRESET_IDS.length;
        this.game.setWeather(next);
        console.log(`[${this.roomId}] weather -> ${WEATHER_PRESET_IDS[next]}`);
      }, ROTATE_SECONDS * 1000);
    }
    this.onMessageBytes(COMMANDS_UP, (client: Client, bytes: Uint8Array) => {
      const connection = this.connections.get(client.sessionId);
      if (connection !== undefined) this.bridge.messageHandler?.(connection, bytes);
    });
    // The room clock drives the fixed tick instead of GameServer.start(), so
    // disposal and lifetime belong to Colyseus.
    this.setSimulationInterval(() => this.game.tick(), tickMs);
    // A fixed-tick loop that never reports its own health quietly falls behind.
    this.clock.setInterval(() => {
      if (this.game.room.size === 0) return;
      const usedMs = this.game.room.motorMilliseconds + this.game.room.worldMilliseconds;
      console.log(
        `[${this.roomId}] ${this.game.room.size} online — tick ${this.game.room.tick}, ` +
          `${usedMs.toFixed(2)} ms/tick (${((usedMs / tickMs) * 100).toFixed(1)}% budget), ` +
          `${this.game.snapshotsSent} snapshots, ` +
          `${this.game.commandsDiscarded} discarded, ` +
          `${this.game.malformedPacketsDropped} malformed, ` +
          `${this.game.shotsHit}/${this.game.shotsResolved} shots hit, ` +
          `${this.game.fireClaimsRejected} claims rejected`
      );
    }, 5000);
  }

  onJoin(client: Client): void {
    // Ids live on the wire as u16 and world targets own 40,000+, so a room
    // that outlives tens of thousands of joins wraps back to 1 rather than
    // marching into the target band — skipping any id still connected.
    const inUse = new Set([...this.connections.values()].map((c) => c.id));
    do {
      this.nextId = this.nextId >= 39_999 ? 1 : this.nextId + 1;
    } while (inUse.has(this.nextId));
    const id = this.nextId;
    const connection: ServerConnection = {
      id,
      send: (bytes) => client.sendBytes(PACKET_DOWN, bytes),
      close: () => client.leave(),
    };
    this.connections.set(client.sessionId, connection);
    // `client.auth` is whatever static onAuth returned. Recorded at join so the
    // session length is measured from here rather than guessed on the way out.
    const accountId = (client.auth as { accountId?: number | null } | undefined)?.accountId ?? null;
    this.sessions.set(client.sessionId, { accountId, joinedAtMs: Date.now() });
    // Presence, for the friends list. Anonymous joiners are not recorded: with
    // no account there is nobody to be a friend of.
    if (accountId !== null) enterPresence(accountId, client.sessionId, this.roomId);
    this.bridge.connectionHandler?.(connection);

    // The kill feed's name, once the account behind the session is known.
    //
    // Fire-and-forget after the peer exists, because the lookup is a database read
    // and `onJoin` is not async: the player is in the room under the numeric
    // fallback for one round trip and is renamed when the row arrives. An
    // anonymous joiner keeps the fallback, which is the whole reason optional auth
    // stays workable — every documented dev URL joins with no token at all.
    if (accountId !== null) {
      void accounts.repository
        .findById(accountId)
        .then((row) => {
          if (row !== undefined) this.game.setDisplayName(id, row.callsign);
        })
        .catch((error: unknown) => {
          console.warn(`[${this.roomId}] could not read a callsign for ${accountId}:`, error);
        });
    }

    // Tell this client what it needs to invite others. Sent to EVERY member of a
    // private room, not only its creator: anyone already inside got there with the
    // code, so they know it — the only person who does not is the host, and
    // singling them out would mean tracking who created the room for no gain.
    // A public room carries no code, because there is nothing to gate. The map
    // always rides along: it is how the client detects that it loaded a
    // different terrain than this room simulates (RoomInfo.map).
    const meta = this.metadata as RoomMetadata | undefined;
    const info: RoomInfo = {
      map: MAP_SLUG,
      ...(meta?.joinCode !== undefined ? { joinCode: meta.joinCode } : {}),
    };
    client.send(ROOM_INFO, info);

    console.log(
      `[${this.roomId}] player ${id} joined (${this.connections.size} online)` +
        (accountId === null ? " [anonymous]" : ` [account ${accountId}]`)
    );
  }

  onLeave(client: Client): void {
    const connection = this.connections.get(client.sessionId);
    if (connection === undefined) return;
    this.connections.delete(client.sessionId);

    // Credit the session. This is what makes the leaderboard real rather than a
    // table of zeros — and it is fire-and-forget on purpose: a database hiccup
    // must not stop the room tearing a player down. Only matches and time played
    // are written; kills need the authority work on feat/server-ballistics, and
    // taking a client's word for them would be worse than a zero.
    const session = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    // Cleared before anything that can throw. Keyed by session, so a player who
    // is also connected from somewhere else keeps their presence there.
    if (session?.accountId != null) leavePresence(session.accountId, client.sessionId);
    if (session !== undefined && session.accountId !== null) {
      const seconds = Math.min(MAX_SESSION_SECONDS, (Date.now() - session.joinedAtMs) / 1000);
      const accountId = session.accountId;
      void accounts.repository
        .recordSession(accountId, seconds)
        // Medals are evaluated AFTER the session is written and from the stored
        // career, so the match that crosses a threshold is the one that awards
        // it. Chained rather than fired alongside: run together, the medal check
        // would read the career from before this session.
        .then(async () => {
          const fresh = await accounts.repository.syncMedals(accountId);
          if (fresh.length > 0) {
            console.log(`[${this.roomId}] account ${accountId} earned ${fresh.join(", ")}`);
          }
        })
        .catch((error: unknown) => console.warn(`[${this.roomId}] career write failed:`, error));
    }

    this.bridge.disconnectionHandler?.(connection);
    console.log(
      `[${this.roomId}] player ${connection.id} left (${this.connections.size} online)`
    );
  }

  async onDispose(): Promise<void> {
    await this.game.stop();
  }
}

const transport = new WebSocketTransport();

/**
 * Who is in which room, right now. Account id -> its live sessions -> room id.
 *
 * Module scope for the same reason `accounts` below is: the rooms write it and
 * the HTTP layer reads it, and there is no instance either of them shares. In
 * memory on purpose — presence is worthless the moment the process restarts, so
 * persisting it would only create stale rows claiming people are playing.
 *
 * Keyed by SESSION and not just by account, because one account genuinely can be
 * in two rooms at once — `recordSession` says as much where it explains why the
 * career write is an incrementing UPDATE. A flat `Map<accountId, roomId>` let the
 * second join overwrite the first, and then the second leave deleted presence
 * entirely while the player was still in the other room, so a friend who was
 * playing read as offline.
 *
 * Read ONLY through the friends endpoint, which filters it to accepted friends.
 * Publishing which room a named player is in would be a stalking primitive, and
 * in a game about not being seen it is also a gameplay leak.
 */
const PRESENCE = new Map<number, Map<string, string>>();

/** Record that a session is in a room. */
function enterPresence(accountId: number, sessionId: string, roomId: string): void {
  const rooms = PRESENCE.get(accountId);
  if (rooms === undefined) PRESENCE.set(accountId, new Map([[sessionId, roomId]]));
  else rooms.set(sessionId, roomId);
}

/** Forget one session, and the account with it once its last session is gone. */
function leavePresence(accountId: number, sessionId: string): void {
  const rooms = PRESENCE.get(accountId);
  if (rooms === undefined) return;
  rooms.delete(sessionId);
  if (rooms.size === 0) PRESENCE.delete(accountId);
}

/**
 * Flatten to the shape the friends endpoint wants: one room per account.
 *
 * Any of them will do — the endpoint answers "is this friend in a game", and
 * listing every room a person is in would publish more, not less.
 */
function presenceSnapshot(): ReadonlyMap<number, string> {
  const flat = new Map<number, string>();
  for (const [accountId, rooms] of PRESENCE) {
    const first = rooms.values().next();
    if (first.done !== true) flat.set(accountId, first.value);
  }
  return flat;
}

/**
 * Held at module scope because `Room.onAuth` is STATIC — Colyseus calls it before
 * any instance exists, so it cannot reach the repository through `this`.
 *
 * Accounts live in this same process and on this same port: the transport already
 * owns an Express app, so /auth and /api are mounted on it rather than standing up
 * a second server. Assembly is in tools/account/mount.ts to keep this file the
 * game's — it refuses to start without JWT_SECRET and AUTH_SALT, deliberately.
 */
const accounts: MountedAccounts = await mountAccounts(transport.getExpressApp(), {
  presence: presenceSnapshot,
});

const server = new Server({ transport });
// filterBy on the create option, so joinOrCreate only ever matches a room of the
// same input class. That is what "no cross-play" means mechanically; the browser's
// own filter (lobbyApi) is the same rule applied to the listing.
server.define(GAME_ROOM, GameRoom).filterBy(["inputClass"]);
await server.listen(PORT);
console.log(
  `game server on ws://localhost:${PORT} — ${MAP_SLUG}, ` +
    `${Math.round(1000 / tickMs)} Hz tick, ${PATCH_HZ} Hz patch, weather ${WEATHER_LABEL}` +
    (ADMIN ? ", CLIENT DIALS ALLOWED (DF2_ADMIN=1)" : "")
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nshutting down");
    void server.gracefullyShutdown();
  });
}
