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
import { TERRAIN_SLUG } from "../../src/df2/config.ts";
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
/** The whole tile: the client walks an endlessly tiling map, the server's
 * static collider has real edges, so cover all of it. */
const SURFACE_SPAN_METRES = 2048;

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

const RAPIER = await initRapier();
const terrain = loadServerTerrain(TERRAIN_SLUG);
const tickMs = DEFAULT_MOTOR_TUNING.fixedTimestepSeconds * 1000;

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

  private readonly bridge = new RoomBridge();
  private readonly connections = new Map<string, ServerConnection>();
  /** sessionId -> the account behind it, and when it joined. */
  private readonly sessions = new Map<
    string,
    { accountId: number | null; joinedAtMs: number }
  >();
  private nextId = 1;
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
    });
    // A private room is excluded from matchmaking and from the browser by
    // Colyseus itself; the code is how it is reachable at all. Generated here so
    // it exists before the first client can ask for it.
    const joinCode = isPrivate ? makeJoinCode() : undefined;
    if (isPrivate) this.setPrivate(true);
    this.metadata = {
      label: label ?? `${TERRAIN_SLUG} — ${isPrivate ? "private" : "public"}`,
      map: TERRAIN_SLUG,
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
          `${this.game.malformedPacketsDropped} malformed`
      );
    }, 5000);
  }

  onJoin(client: Client): void {
    const id = this.nextId;
    this.nextId += 1;
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
    this.bridge.connectionHandler?.(connection);

    // Tell this client what it needs to invite others. Sent to EVERY member of a
    // private room, not only its creator: anyone already inside got there with the
    // code, so they know it — the only person who does not is the host, and
    // singling them out would mean tracking who created the room for no gain.
    // A public room sends an empty object, because there is nothing to gate.
    const meta = this.metadata as RoomMetadata | undefined;
    const info: RoomInfo = meta?.joinCode !== undefined ? { joinCode: meta.joinCode } : {};
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
    if (session !== undefined && session.accountId !== null) {
      const seconds = (Date.now() - session.joinedAtMs) / 1000;
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
 * Held at module scope because `Room.onAuth` is STATIC — Colyseus calls it before
 * any instance exists, so it cannot reach the repository through `this`.
 */
let accounts: MountedAccounts;
// Accounts live in this same process and on this same port: the transport already
// owns an Express app, so /auth and /api are mounted on it rather than standing up
// a second server. Assembly is in tools/account/mount.ts to keep this file the
// game's — it refuses to start without JWT_SECRET and AUTH_SALT, deliberately.
accounts = await mountAccounts(transport.getExpressApp());

const server = new Server({ transport });
// filterBy on the create option, so joinOrCreate only ever matches a room of the
// same input class. That is what "no cross-play" means mechanically; the browser's
// own filter (lobbyApi) is the same rule applied to the listing.
server.define(GAME_ROOM, GameRoom).filterBy(["inputClass"]);
await server.listen(PORT);
console.log(
  `game server on ws://localhost:${PORT} — ${TERRAIN_SLUG}, ` +
    `${Math.round(1000 / tickMs)} Hz tick, ${PATCH_HZ} Hz patch, weather ${WEATHER_LABEL}` +
    (ADMIN ? ", CLIENT DIALS ALLOWED (DF2_ADMIN=1)" : "")
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nshutting down");
    void server.gracefullyShutdown();
  });
}
