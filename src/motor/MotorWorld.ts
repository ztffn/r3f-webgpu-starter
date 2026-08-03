// Rapier bootstrap shared by the browser and the Node server.
//
// The compat build inlines its WASM as base64 and initialises asynchronously,
// which is exactly why it is the chosen variant: one import path works under
// Vite with no wasm plugin and under Node with no loader flags. The non-SIMD
// build is deliberate — SIMD availability varies per machine and would discard
// the cross-platform step determinism that keeps corrections small.

import RAPIER from "@dimforge/rapier3d-compat";
import { DEFAULT_MOTOR_TUNING, type MotorTuning } from "./MotorTypes.ts";

let initialised: Promise<typeof RAPIER> | null = null;

/** Idempotent. Every caller awaits the same initialisation. */
export function initRapier(): Promise<typeof RAPIER> {
  initialised ??= RAPIER.init().then(() => RAPIER);
  return initialised;
}

export function createMotorWorld(
  rapier: typeof RAPIER,
  tuning: MotorTuning = DEFAULT_MOTOR_TUNING
): RAPIER.World {
  const world = new rapier.World({
    x: 0,
    y: -tuning.gravityMetresPerSecondSquared,
    z: 0,
  });
  world.timestep = tuning.fixedTimestepSeconds;
  return world;
}

/** Flat ground at a fixed elevation. The simplest terrain a test can assert on. */
export function flatHeightSource(elevation = 0, cellSize = 2): {
  cellSize: number;
  sample(): number;
} {
  return { cellSize, sample: () => elevation };
}
