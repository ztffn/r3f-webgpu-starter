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
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameServer } from "../../src/net/GameServer.ts";
import {
  COMMANDS_UP,
  GAME_ROOM,
  PACKET_DOWN,
} from "../../src/net/ColyseusProtocol.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import { DEFAULT_MOTOR_TUNING } from "../../src/motor/MotorTypes.ts";
import type { ServerConnection, ServerTransport } from "../../src/net/Transport.ts";
import { TERRAIN_SLUG } from "../../src/df2/config.ts";
import { WEATHER_PRESET_IDS, weatherPresetIndex } from "../../src/df2/weather.ts";
import { clampVisualDial } from "../../src/df2/visualDials.ts";
import { loadServerTerrain } from "./terrain.ts";

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
  private nextId = 0;
  private game!: GameServer;

  onCreate(): void {
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
    console.log(`[${this.roomId}] weather: ${WEATHER_PRESET_IDS[weatherIndex]}`);
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
    this.bridge.connectionHandler?.(connection);
    console.log(`[${this.roomId}] player ${id} joined (${this.connections.size} online)`);
  }

  onLeave(client: Client): void {
    const connection = this.connections.get(client.sessionId);
    if (connection === undefined) return;
    this.connections.delete(client.sessionId);
    this.bridge.disconnectionHandler?.(connection);
    console.log(
      `[${this.roomId}] player ${connection.id} left (${this.connections.size} online)`
    );
  }

  async onDispose(): Promise<void> {
    await this.game.stop();
  }
}

const server = new Server({ transport: new WebSocketTransport() });
server.define(GAME_ROOM, GameRoom);
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
