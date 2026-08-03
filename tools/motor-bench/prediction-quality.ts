// Prediction quality under link conditions — measurement 3 of the decision
// record: correction rate and magnitude under representative latency and loss.
//
// Runs one scripted player through the real server, client, codec and
// reconciliation over a simulated link, and reports how far prediction strays
// from authority and how far the player is actually moved to fix it.
//
// Run: node --experimental-strip-types --experimental-specifier-resolution=node \
//        tools/motor-bench/prediction-quality.ts

import { GameClient } from "../../src/net/GameClient.ts";
import { GameServer } from "../../src/net/GameServer.ts";
import { LoopbackNetwork, type LinkConditions } from "../../src/net/LoopbackTransport.ts";
import { createMotorWorld, initRapier } from "../../src/motor/MotorWorld.ts";
import {
  DEFAULT_MOTOR_TUNING,
  MotorInput,
  type MotorHeightSource,
} from "../../src/motor/MotorTypes.ts";

const RAPIER = await initRapier();
const TICK_MS = DEFAULT_MOTOR_TUNING.fixedTimestepSeconds * 1000;
const TICKS = 1800; // 30 seconds of play

const terrain: MotorHeightSource = {
  cellSize: 2,
  sample: (x, z) => Math.sin(x * 0.02) * 5 + Math.cos(z * 0.017) * 4,
};

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface Row {
  label: string;
  worstDrift: number;
  meanDrift: number;
  worstCorrection: number;
  corrections: number;
  reconciles: number;
  replayed: number;
  discarded: number;
}

function measure(label: string, conditions: LinkConditions): Row {
  const network = new LoopbackNetwork();
  const server = new GameServer(RAPIER, createMotorWorld(RAPIER), terrain, network, {
    sharedSurfaceSpanMetres: 512,
    patchHz: 20,
  });
  const client = new GameClient(
    RAPIER,
    createMotorWorld(RAPIER),
    terrain,
    network.connect(conditions)
  );

  let driftTotal = 0;
  let driftSamples = 0;
  let seenReconciles = 0;

  for (let tick = 0; tick < TICKS; tick += 1) {
    const buttons =
      MotorInput.Forward |
      (tick % 150 === 0 ? MotorInput.Jump : 0) |
      (tick % 400 > 320 ? MotorInput.Crouch : 0) |
      (tick % 260 > 200 ? MotorInput.Sprint : 0);
    client.predict(buttons, Math.sin(tick * 0.006) * 2.2, 0);
    network.advance(TICK_MS / 2);
    server.tick();
    network.advance(TICK_MS / 2);

    if (client.reconciles > seenReconciles) {
      seenReconciles = client.reconciles;
      driftTotal += client.lastDriftMetres;
      driftSamples += 1;
    }
  }

  return {
    label,
    worstDrift: client.worstDriftMetres,
    meanDrift: driftSamples > 0 ? driftTotal / driftSamples : 0,
    worstCorrection: client.worstCorrectionMetres,
    corrections: client.corrections,
    reconciles: client.reconciles,
    replayed: client.replayedCommands,
    discarded: server.commandsDiscarded,
  };
}

const scenarios: Array<[string, LinkConditions]> = [
  ["localhost", {}],
  ["20ms LAN", { latencyMs: 20, jitterMs: 4, random: seeded(1) }],
  ["60ms broadband", { latencyMs: 60, jitterMs: 12, random: seeded(2) }],
  ["60ms + 2% loss", { latencyMs: 60, jitterMs: 12, loss: 0.02, random: seeded(3) }],
  ["120ms + 5% loss", { latencyMs: 120, jitterMs: 30, loss: 0.05, random: seeded(4) }],
  ["250ms + 10% loss", { latencyMs: 250, jitterMs: 60, loss: 0.1, random: seeded(5) }],
];

console.log(`Prediction quality — ${TICKS} ticks (${(TICKS / 60).toFixed(0)} s), 60 Hz tick, 20 Hz patch\n`);
const header = [
  "link".padEnd(18),
  "worst drift".padStart(11),
  "mean drift".padStart(10),
  "worst corr".padStart(10),
  "corr".padStart(6),
  "recon".padStart(6),
  "replayed".padStart(9),
  "dropped".padStart(8),
];
console.log(header.join("  "));
console.log("-".repeat(header.join("  ").length));

for (const [label, conditions] of scenarios) {
  const row = measure(label, conditions);
  console.log(
    [
      row.label.padEnd(18),
      `${row.worstDrift.toFixed(3)} m`.padStart(11),
      `${row.meanDrift.toFixed(4)} m`.padStart(10),
      `${row.worstCorrection.toFixed(3)} m`.padStart(10),
      String(row.corrections).padStart(6),
      String(row.reconciles).padStart(6),
      String(row.replayed).padStart(9),
      String(row.discarded).padStart(8),
    ].join("  ")
  );
}

console.log(
  "\nDrift is prediction versus authority when a snapshot lands." +
    "\nCorrection is how far the player was actually moved after replay." +
    "\nBoth runtimes are Node here, so this is not yet a cross-runtime result."
);
