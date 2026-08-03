// Transport overhead bench — the measurement §5 of the decision record defers on.
// Runs the SAME GameServer and scripted 64-client load under a swappable
// transport (ws | colyseus) and reports per-tick wall time, whole-process CPU
// per tick, and event-loop delay. The difference between transports is the
// framework's own overhead on top of the dense-room bench's 2.09 ms motor cost.
//
// Run each kind in its own process so nothing bleeds between configurations:
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     tools/transport-bench/run.ts ws 64
//   node ... tools/transport-bench/run.ts colyseus 64

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WebSocketServer, type WebSocket } from "ws";
import { GameServer } from "../../src/net/GameServer.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  type MotorHeightSource,
} from "../../src/motor/MotorTypes.ts";
import type { ServerConnection, ServerTransport } from "../../src/net/Transport.ts";

const kind = process.argv[2] ?? "ws";
const players = Number(process.argv[3] ?? 64);
const PORT = { ws: 8791, colyseus: 8792, "colyseus-uws": 8793 }[kind] ?? 8791;
const ROOM_SPAN_METRES = 1024;
const SETTLE_MS = 5_000;
const MEASURE_MS = 30_000;

const TICK_HZ = Math.round(1 / DEFAULT_MOTOR_TUNING.fixedTimestepSeconds);

/** Identical terrain and spawn disc to the dense-room bench, for comparability. */
const terrain: MotorHeightSource = {
  cellSize: 2,
  sample: (x, z) => Math.sin(x * 0.01) * 8 + Math.cos(z * 0.013) * 6,
};

function spawnRing(seat: number): { x: number; z: number } {
  const index = seat % players;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const radius = 30 * Math.sqrt((index + 0.5) / players);
  return { x: Math.cos(index * golden) * radius, z: Math.sin(index * golden) * radius };
}

/** Same disposable shape as tools/session-test/server.ts, kept local on purpose. */
class WsServerTransport implements ServerTransport {
  private readonly server: WebSocketServer;
  private nextId = 1;
  private connectionHandler: ((connection: ServerConnection) => void) | null = null;
  private messageHandler: ((connection: ServerConnection, bytes: Uint8Array) => void) | null =
    null;
  private disconnectionHandler: ((connection: ServerConnection) => void) | null = null;

  constructor(port: number) {
    this.server = new WebSocketServer({ port });
    this.server.on("connection", (socket: WebSocket) => {
      const id = this.nextId;
      this.nextId += 1;
      const connection: ServerConnection = {
        id,
        send: (bytes) => {
          if (socket.readyState === socket.OPEN) socket.send(bytes);
        },
        close: () => socket.close(),
      };
      this.connectionHandler?.(connection);
      socket.on("message", (data: Buffer) => {
        this.messageHandler?.(connection, new Uint8Array(data));
      });
      socket.on("close", () => this.disconnectionHandler?.(connection));
    });
  }

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
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

const RAPIER = await initRapier();

let transport: ServerTransport;
let stopFramework: (() => Promise<void>) | null = null;
if (kind === "ws") {
  transport = new WsServerTransport(PORT);
} else if (kind === "colyseus" || kind === "colyseus-uws") {
  const { createColyseusTransport } = await import("./colyseus-room.ts");
  const created = await createColyseusTransport(PORT, kind === "colyseus-uws");
  transport = created.transport;
  stopFramework = created.stop;
} else {
  console.error(`unknown transport kind: ${kind}`);
  process.exit(1);
}

const server = new GameServer(RAPIER, createMotorWorld(RAPIER), terrain, transport, {
  sharedSurfaceSpanMetres: ROOM_SPAN_METRES,
  patchHz: 20,
  spawn: spawnRing,
});
server.start();
console.log(`${kind} server on port ${PORT}, ${TICK_HZ} Hz tick, 20 Hz patch`);

// Shard clients across processes: 64 SDK clients saturate a single Node
// process, and a starved load generator sends in bursts that read as server
// overhead. BENCH_CHILDREN=1 reproduces the old single-process behaviour.
const childCount = Number(process.env.BENCH_CHILDREN ?? 4);
const perChild = Math.ceil(players / childCount);
const reports = new Map<number, { connected: number; snapshotsReceived: number }>();
const children = Array.from({ length: childCount }, (_, index) => {
  const child = fork(
    fileURLToPath(new URL("./load-clients.ts", import.meta.url)),
    [
      kind.startsWith("colyseus") ? "colyseus" : "ws",
      `ws://localhost:${PORT}`,
      String(Math.min(perChild, players - index * perChild)),
      String(index * perChild),
    ],
    {
      execArgv: ["--experimental-strip-types", "--experimental-specifier-resolution=node"],
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    }
  );
  child.on("message", (message) => {
    reports.set(index, message as { connected: number; snapshotsReceived: number });
  });
  return child;
});
const clientReport = () => {
  let connected = 0;
  let snapshotsReceived = 0;
  for (const report of reports.values()) {
    connected += report.connected;
    snapshotsReceived += report.snapshotsReceived;
  }
  return { connected, snapshotsReceived };
};

// Wait for the full room before measuring anything.
await new Promise<void>((resolve, reject) => {
  const deadline = Date.now() + 60_000;
  const poll = setInterval(() => {
    if (server.room.size >= players) {
      clearInterval(poll);
      resolve();
    } else if (Date.now() > deadline) {
      clearInterval(poll);
      reject(new Error(`room never filled: ${server.room.size}/${players}`));
    }
  }, 250);
});
console.log(`${players} clients joined; draining, then starting load`);
// Let join-time queue residue drain before any client sends, so the catch-up
// path is not primed to spiral before the measurement even starts.
await new Promise((resolve) => setTimeout(resolve, 2_000));
for (const child of children) child.send("go");
console.log(`load running; settling ${SETTLE_MS / 1000}s`);
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

// Instrument the live server: shadow tick() with a timing wrapper. start()'s
// interval closure calls this.tick(), so the shadow is picked up mid-run.
const tickSamples: number[] = [];
const originalTick = server.tick.bind(server);
(server as { tick: () => void }).tick = () => {
  const started = performance.now();
  originalTick();
  tickSamples.push(performance.now() - started);
};

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const cpuBefore = process.cpuUsage();
const wallBefore = performance.now();
const snapshotsBefore = server.snapshotsSent;

console.log(`measuring ${MEASURE_MS / 1000}s...`);
let lastCount = 0;
const health = setInterval(() => {
  const count = tickSamples.length;
  console.log(`  ${((count - lastCount) / 10).toFixed(1)} ticks/s over the last 10s`);
  lastCount = count;
}, 10_000);
await new Promise((resolve) => setTimeout(resolve, MEASURE_MS));
clearInterval(health);

const cpu = process.cpuUsage(cpuBefore);
const wallMs = performance.now() - wallBefore;
loopDelay.disable();

const ticks = tickSamples.length;
const sorted = tickSamples.slice().sort((a, b) => a - b);
const tickMeanMs = tickSamples.reduce((sum, v) => sum + v, 0) / ticks;
const cpuMsPerTick = (cpu.user + cpu.system) / 1000 / ticks;
const budgetMs = 1000 / TICK_HZ;

console.log(`\n=== ${kind}, ${players} players, node ${process.version} ===`);
console.log(`ticks measured        ${ticks} (${((ticks / wallMs) * 1000).toFixed(1)}/s)`);
console.log(
  `tick wall time        mean ${tickMeanMs.toFixed(3)} ms, ` +
    `p99 ${percentile(sorted, 0.99).toFixed(3)} ms  ` +
    `(${((tickMeanMs / budgetMs) * 100).toFixed(1)}% of ${budgetMs.toFixed(2)} ms budget)`
);
console.log(
  `process CPU per tick  ${cpuMsPerTick.toFixed(3)} ms ` +
    `(user ${(cpu.user / 1000 / ticks).toFixed(3)}, sys ${(cpu.system / 1000 / ticks).toFixed(3)})`
);
console.log(
  `event loop delay      mean ${(loopDelay.mean / 1e6).toFixed(2)} ms, ` +
    `p99 ${(loopDelay.percentile(99) / 1e6).toFixed(2)} ms`
);
const finalReport = clientReport();
console.log(
  `snapshots sent        ${server.snapshotsSent - snapshotsBefore} ` +
    `(clients saw ${finalReport.snapshotsReceived} total, ` +
    `${finalReport.connected} connected)`
);
console.log(
  `server counters       stale ${server.staleCommandsDropped}, ` +
    `discarded ${server.commandsDiscarded}, malformed ${server.malformedPacketsDropped}`
);

for (const child of children) child.kill();
await server.stop();
await stopFramework?.();
process.exit(0);
