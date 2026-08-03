// Dense-room cost benchmark — measurement 2 of the multiplayer decision record.
//
// Answers the question that decides Colyseus versus a custom room loop: what
// does one room of 64 fixed-tick character motors cost on the server, and how
// many bytes per second does each client have to receive to see it?
//
// Run: node --experimental-strip-types --experimental-specifier-resolution=node \
//        tools/motor-bench/dense-room.ts

import { MotorRoom, type RoomSnapshot } from "../../src/motor/MotorRoom.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorInput,
  type MotorHeightSource,
  type PlayerCommand,
} from "../../src/motor/MotorTypes.ts";
import { BYTES_PER_PLAYER } from "../../src/net/SnapshotCodec.ts";

const RAPIER = await initRapier();

const TICK_HZ = Math.round(1 / DEFAULT_MOTOR_TUNING.fixedTimestepSeconds);
const WARMUP_TICKS = 120;
const MEASURED_TICKS = 600;
const ROOM_SPAN_METRES = 1024;

/** Rolling terrain, so nobody is benchmarking a flat plane. */
const terrain: MotorHeightSource = {
  cellSize: 2,
  sample: (x, z) => Math.sin(x * 0.01) * 8 + Math.cos(z * 0.013) * 6,
};

/**
 * Players packed into a disc so they genuinely contend: a dense room is the
 * case that decides the framework, and spreading 64 players over a whole map
 * would measure the easy case instead.
 */
function spawnRing(index: number, count: number): { x: number; z: number } {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const radius = 30 * Math.sqrt((index + 0.5) / count);
  return { x: Math.cos(index * golden) * radius, z: Math.sin(index * golden) * radius };
}

/** Every player moving and turning, which is the worst realistic case. */
function scriptedCommand(tick: number, seat: number): PlayerCommand {
  const phase = tick * 0.02 + seat;
  let buttons = MotorInput.Forward;
  if ((seat + tick) % 97 < 8) buttons |= MotorInput.Jump;
  if ((seat * 7 + tick) % 211 < 40) buttons |= MotorInput.Crouch;
  if (seat % 5 === 0) buttons |= MotorInput.Sprint;
  return { tick, buttons, yawRadians: Math.sin(phase) * Math.PI, pitchRadians: 0 };
}

/** Hand-packed binary, the format §5 says the hot path should use. */
function packedSnapshotBytes(players: number): number {
  return 4 + players * BYTES_PER_PLAYER;
}

function percentile(sorted: Float64Array, fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

interface Row {
  players: number;
  shared: boolean;
  meanMs: number;
  p99Ms: number;
  motorShare: number;
  jsonBytes: number;
  packedBytes: number;
}

function measure(players: number, shared: boolean): Row {
  const world = createMotorWorld(RAPIER);
  const room = new MotorRoom(RAPIER, world, terrain, {
    ...(shared ? { sharedSurfaceSpanMetres: ROOM_SPAN_METRES } : {}),
  });
  for (let seat = 0; seat < players; seat += 1) {
    room.add(`p${seat}`, spawnRing(seat, players));
  }

  const commands = new Map<string, PlayerCommand>();
  const fill = (tick: number) => {
    let seat = 0;
    for (const id of room.playerIds) {
      commands.set(id, scriptedCommand(tick, seat));
      seat += 1;
    }
  };

  for (let tick = 0; tick < WARMUP_TICKS; tick += 1) {
    fill(tick);
    room.step(commands);
  }

  const samples = new Float64Array(MEASURED_TICKS);
  let motorTotal = 0;
  let total = 0;
  for (let tick = 0; tick < MEASURED_TICKS; tick += 1) {
    fill(WARMUP_TICKS + tick);
    const started = performance.now();
    room.step(commands);
    const elapsed = performance.now() - started;
    samples[tick] = elapsed;
    total += elapsed;
    motorTotal += room.motorMilliseconds;
  }

  const snapshot: RoomSnapshot = { tick: 0, players: [] };
  room.snapshotInto(snapshot);
  const jsonBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  room.dispose();

  const sorted = samples.slice().sort();
  return {
    players,
    shared,
    meanMs: total / MEASURED_TICKS,
    p99Ms: percentile(sorted, 0.99),
    motorShare: motorTotal / total,
    jsonBytes,
    packedBytes: packedSnapshotBytes(players),
  };
}

const budgetMs = 1000 / TICK_HZ;
console.log(`Dense-room cost — ${TICK_HZ} Hz tick, budget ${budgetMs.toFixed(2)} ms/tick`);
console.log(
  `${MEASURED_TICKS} measured ticks after ${WARMUP_TICKS} warmup, node ${process.version}\n`
);

const header = [
  "players".padStart(7),
  "surface".padStart(10),
  "mean ms".padStart(8),
  "p99 ms".padStart(7),
  "budget".padStart(7),
  "motor%".padStart(7),
  "json B/s".padStart(10),
  "packed B/s".padStart(11),
];
console.log(header.join("  "));
console.log("-".repeat(header.join("  ").length));

for (const shared of [true, false]) {
  for (const players of [1, 16, 32, 64]) {
    const row = measure(players, shared);
    console.log(
      [
        String(row.players).padStart(7),
        (row.shared ? "shared" : "per-player").padStart(10),
        row.meanMs.toFixed(3).padStart(8),
        row.p99Ms.toFixed(3).padStart(7),
        `${((row.meanMs / budgetMs) * 100).toFixed(1)}%`.padStart(7),
        `${(row.motorShare * 100).toFixed(0)}%`.padStart(7),
        (row.jsonBytes * TICK_HZ).toLocaleString().padStart(10),
        (row.packedBytes * TICK_HZ).toLocaleString().padStart(11),
      ].join("  ")
    );
  }
}

console.log(
  "\nBytes columns are one client receiving the whole room at full tick rate;" +
    "\na real server sends at a lower patch rate and culls by visibility."
);
