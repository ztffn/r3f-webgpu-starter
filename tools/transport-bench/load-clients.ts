// Scripted client load for the transport bench — the child-process half.
// Connects N clients over the requested transport (ws | colyseus), drives each
// with the dense-room scripted command stream at the motor tick rate, sending
// the 3-command unacknowledged tail a real GameClient would, and reports the
// snapshots received so the parent can sanity-check the run saw real traffic.
//
// Run (forked by run.ts, but standalone works):
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     tools/transport-bench/load-clients.ts ws ws://localhost:8791 64

import WebSocket from "ws";
import {
  PacketType,
  encodeCommands,
  packetTypeOf,
} from "../../src/net/SnapshotCodec.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorInput,
  type PlayerCommand,
} from "../../src/motor/MotorTypes.ts";

const kind = process.argv[2] ?? "ws";
const url = process.argv[3] ?? "ws://localhost:8791";
const count = Number(process.argv[4] ?? 64);
/** First seat this process owns; run.ts shards clients across processes. */
const baseSeat = Number(process.argv[5] ?? 0);

const SEND_HZ = Math.round(1 / DEFAULT_MOTOR_TUNING.fixedTimestepSeconds);
/** A real client resends its unacknowledged tail; 3 commands is the typical depth. */
const TAIL = 3;

let snapshotsReceived = 0;
let connected = 0;

/**
 * Clients connect immediately but only start SENDING on the parent's "go",
 * which arrives after the room is full and drained. Without this, the join
 * phase stalls the server loop, every peer's queue passes the catch-up
 * threshold at once, and the catch-up drain's full room step per backed-up
 * peer amplifies one stall into a permanent death spiral — measuring our own
 * pathology instead of the transport.
 */
const starters: Array<() => void> = [];
let started = false;
function registerStarter(start: () => void): void {
  if (started) start();
  else starters.push(start);
}
process.on("message", (message) => {
  if (message !== "go" || started) return;
  started = true;
  for (const start of starters) start();
});
process.on("disconnect", () => process.exit(0));

/** Identical to the dense-room bench so the load is comparable to its 2.09 ms. */
function scriptedCommand(tick: number, seat: number): PlayerCommand {
  const phase = tick * 0.02 + seat;
  let buttons = MotorInput.Forward;
  if ((seat + tick) % 97 < 8) buttons |= MotorInput.Jump;
  if ((seat * 7 + tick) % 211 < 40) buttons |= MotorInput.Crouch;
  if (seat % 5 === 0) buttons |= MotorInput.Sprint;
  return { tick, buttons, yawRadians: Math.sin(phase) * Math.PI, pitchRadians: 0 };
}

function commandTail(tick: number, seat: number): Uint8Array {
  const commands: PlayerCommand[] = [];
  for (let back = TAIL - 1; back >= 0; back -= 1) {
    if (tick - back < 1) continue;
    commands.push(scriptedCommand(tick - back, seat));
  }
  return encodeCommands(commands);
}

function startWsClient(seat: number): void {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  socket.on("open", () => {
    connected += 1;
    registerStarter(() => {
      // Staggered start so 64 clients do not send in one synchronised burst.
      setTimeout(() => {
        timer = setInterval(() => {
          tick += 1;
          socket.send(commandTail(tick, seat));
        }, 1000 / SEND_HZ);
      }, seat * 3);
    });
  });
  socket.on("message", (data: Buffer) => {
    if (packetTypeOf(new Uint8Array(data)) === PacketType.Snapshot) snapshotsReceived += 1;
  });
  socket.on("close", () => {
    connected -= 1;
    if (timer !== null) clearInterval(timer);
  });
  socket.on("error", (error) => {
    console.error(`client ${seat}: ${String(error)}`);
  });
}

async function startColyseusClient(seat: number): Promise<void> {
  const { joinBenchRoom } = await import("./colyseus-client.ts");
  await joinBenchRoom(url, seat, {
    sendHz: SEND_HZ,
    staggerMs: seat * 3,
    registerStarter,
    commandTail: (tick) => commandTail(tick, seat),
    onConnected: () => {
      connected += 1;
    },
    onMessageBytes: (bytes) => {
      if (packetTypeOf(bytes) === PacketType.Snapshot) snapshotsReceived += 1;
    },
  });
}

if (kind === "ws") {
  for (let seat = baseSeat; seat < baseSeat + count; seat += 1) startWsClient(seat);
} else if (kind === "colyseus") {
  for (let seat = baseSeat; seat < baseSeat + count; seat += 1) {
    startColyseusClient(seat).catch((error) => {
      console.error(`client ${seat} failed to join: ${String(error)}`);
    });
  }
} else {
  console.error(`unknown transport kind: ${kind}`);
  process.exit(1);
}

// The parent watches these lines to know the load is really flowing.
setInterval(() => {
  if (process.connected) process.send?.({ connected, snapshotsReceived });
}, 1000);
