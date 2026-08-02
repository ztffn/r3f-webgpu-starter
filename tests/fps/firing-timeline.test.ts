import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";
import { AimSwayController } from "../../src/fps/core/AimSwayController.ts";
import {
  FiringTimeline,
  createFiringTimelineFrame,
  clampSimulationDelta,
  MAX_SIMULATION_FRAME_SECONDS,
} from "../../src/fps/core/FiringTimeline.ts";
import {
  BallisticProjectileSystem,
  type BallisticResult,
} from "../../src/fps/combat/BallisticProjectileSystem.ts";
import type { BallisticEnvironment } from "../../src/fps/combat/BallisticEnvironment.ts";
import type { WorldQuery } from "../../src/fps/core/WorldQuery.ts";
import { LoadoutSystem } from "../../src/fps/weapons/LoadoutSystem.ts";
import { WeaponSystem } from "../../src/fps/weapons/WeaponSystem.ts";
import type { WeaponDefinition } from "../../src/fps/weapons/WeaponDefinition.ts";
import { SAW_DEFINITION } from "../../src/fps/weapons/weaponDefinitions.ts";

const MISS_QUERY: WorldQuery = { raycast: () => null };
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const TEST_ELEVATION_RADIANS = 0.012;
const ROUNDS = 40;
const PITCH_RADIANS = -0.08;
const BASE_YAW_RADIANS = 0.35;
const YAW_RATE_RADIANS_PER_SECOND = 0.6;
const START_POSITION = new THREE.Vector3(12, 80, -30);
const VELOCITY = new THREE.Vector3(3.4, 0, -2.1);

/** Stand-in turret: a fixed elevation keeps the mean bore off the sightline. */
const SIGHT_ADJUSTMENT = {
  applyToSightDirection(sightDirection: THREE.Vector3Like, target: THREE.Vector3): THREE.Vector3 {
    target.set(sightDirection.x, sightDirection.y, sightDirection.z).normalize();
    const right = new THREE.Vector3().crossVectors(target, WORLD_UP);
    if (right.lengthSq() > Number.EPSILON) {
      target.applyAxisAngle(right.normalize(), TEST_ELEVATION_RADIANS);
    }
    return target.normalize();
  },
};

/**
 * 3,000 RPM crosses several cadence boundaries inside one 30 Hz frame, which is
 * exactly the case a per-frame adapter collapses onto a single pose. The
 * magazine ends the burst on an exact cadence boundary, so every render rate
 * produces the same round count without a timing-sensitive trigger release.
 */
const RAPID_DEFINITION: WeaponDefinition = {
  ...SAW_DEFINITION,
  id: "cadence-rig",
  shot: {
    ...SAW_DEFINITION.shot,
    roundsPerMinute: 3_000,
    range: 120,
    maxFlightSeconds: 1,
  },
  ammo: { magazineSize: ROUNDS, initialReserve: 0 },
  fireModes: { supported: ["auto"], default: "auto" },
};

interface PoseTrack {
  readonly planarSpeedMetresPerSecond: number;
  position(seconds: number, target: THREE.Vector3): THREE.Vector3;
  orientation(seconds: number, target: THREE.Quaternion): THREE.Quaternion;
}

const STATIONARY: PoseTrack = {
  planarSpeedMetresPerSecond: 0,
  position: (_seconds, target) => target.copy(START_POSITION),
  orientation: (_seconds, target) =>
    target.setFromEuler(new THREE.Euler(PITCH_RADIANS, BASE_YAW_RADIANS, 0, "YXZ")),
};

/**
 * Yaw at a fixed pitch is `Ry(yaw(t)) · Rx(pitch)` — a left translation of a
 * one-parameter subgroup, so the quaternion path is a great circle and
 * spherical interpolation reproduces it exactly. Only floating point survives.
 */
const MOVING_AND_TURNING: PoseTrack = {
  planarSpeedMetresPerSecond: Math.hypot(VELOCITY.x, VELOCITY.z),
  position: (seconds, target) => target.copy(START_POSITION).addScaledVector(VELOCITY, seconds),
  orientation: (seconds, target) =>
    target.setFromEuler(
      new THREE.Euler(
        PITCH_RADIANS,
        BASE_YAW_RADIANS + YAW_RATE_RADIANS_PER_SECOND * seconds,
        0,
        "YXZ"
      )
    ),
};

/**
 * Both axes sweep, so the true look path is no longer a great circle and the
 * interpolated arc bends away from it. This is the case doc 10 quantifies; the
 * tolerance below is the measured residual, not an aspiration.
 */
const FLICKING: PoseTrack = {
  planarSpeedMetresPerSecond: Math.hypot(VELOCITY.x, VELOCITY.z),
  position: (seconds, target) => target.copy(START_POSITION).addScaledVector(VELOCITY, seconds),
  orientation: (seconds, target) =>
    target.setFromEuler(
      new THREE.Euler(
        PITCH_RADIANS + 1.2 * seconds,
        BASE_YAW_RADIANS + 3 * seconds,
        0,
        "YXZ"
      )
    ),
};

function environment(): BallisticEnvironment {
  return {
    gravity: { x: 0, y: -9.80665, z: 0 },
    windVelocity: { x: 4, y: 0, z: 0 },
    fixedStepSeconds: 1 / 120,
    maxCatchUpSeconds: 0.25,
  };
}

interface SpawnRecord {
  readonly sequence: number;
  readonly frameIndex: number;
  readonly atSeconds: number;
  readonly origin: readonly number[];
  readonly sight: readonly number[];
  readonly bore: readonly number[];
  readonly projectile: readonly number[];
}

interface ResultRecord {
  readonly sequence: number;
  readonly flightTimeSeconds: number;
  readonly pathLengthMetres: number;
  readonly verticalDropMetres: number;
  readonly lateralDriftMetres: number;
  readonly finalPoint: readonly number[];
}

interface CadenceRun {
  readonly spawns: readonly SpawnRecord[];
  readonly results: readonly ResultRecord[];
}

function runCadence(renderHz: number, track: PoseTrack, totalSeconds = 2): CadenceRun {
  const weapon = new WeaponSystem(RAPID_DEFINITION, 4_242);
  const loadout = new LoadoutSystem([{ inputSlot: 1, id: "primary", weapon }], "primary");
  const ballistics = new BallisticProjectileSystem(MISS_QUERY, environment(), {
    capacity: 256,
  });
  const sway = new AimSwayController();
  const timeline = new FiringTimeline({
    ballistics,
    sway,
    sightAdjustmentFor: () => SIGHT_ADJUSTMENT,
  });

  const frame = createFiringTimelineFrame();
  const scratchPosition = new THREE.Vector3();
  const scratchOrientation = new THREE.Quaternion();
  const spawns: SpawnRecord[] = [];
  const results: ResultRecord[] = [];
  const handling = {
    stance: "stand" as const,
    grounded: true,
    planarSpeedMetresPerSecond: track.planarSpeedMetresPerSecond,
    breathStabilization: 0,
  };

  const step = 1 / renderHz;
  let elapsed = 0;
  let frameIndex = 0;
  loadout.handleCommand({ type: "triggerDown" });

  while (elapsed < totalSeconds - 1e-12) {
    const delta = Math.min(step, totalSeconds - elapsed);
    const frameStart = elapsed;
    loadout.setHandlingContext(handling);
    loadout.update(delta);

    frame.deltaSeconds = delta;
    frame.startPosition.copy(track.position(frameStart, scratchPosition));
    frame.endPosition.copy(track.position(frameStart + delta, scratchPosition));
    frame.startOrientation.copy(track.orientation(frameStart, scratchOrientation));
    frame.endOrientation.copy(track.orientation(frameStart + delta, scratchOrientation));
    frame.stance = "stand";
    frame.holdingBreath = false;
    frame.swayHandlingMultiplier = 1;
    frame.adsProgressStart = 0;
    frame.adsProgressEnd = 0;
    frame.captureTrace = false;

    const currentFrame = frameIndex;
    timeline.runFrame(frame, loadout, {
      onShot: (shot) => {
        assert.equal(shot.spawned, true, "the pool must accept every accepted round");
        spawns.push({
          sequence: shot.sequence,
          frameIndex: currentFrame,
          atSeconds: frameStart + shot.acceptedAtOffsetSeconds,
          origin: shot.origin.toArray(),
          sight: shot.sightDirection.toArray(),
          bore: shot.boreDirection.toArray(),
          projectile: shot.projectileDirection.toArray(),
        });
      },
    });

    ballistics.drainImpactEvents(() => {});
    ballistics.drainResults((result: BallisticResult) => {
      results.push({
        sequence: result.shot.sequence,
        flightTimeSeconds: result.trace.flightTimeSeconds,
        pathLengthMetres: result.trace.pathLengthMetres,
        verticalDropMetres: result.trace.verticalDropMetres,
        lateralDriftMetres: result.trace.lateralDriftMetres,
        finalPoint: result.trace.points.at(-1)!.toArray(),
      });
    });

    elapsed += delta;
    frameIndex += 1;
  }

  results.sort((left, right) => left.sequence - right.sequence);
  return { spawns, results };
}

function assertClose(
  actual: readonly number[],
  expected: readonly number[],
  tolerance: number,
  label: string
): void {
  assert.equal(actual.length, expected.length, `${label} arity`);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `${label}[${index}]: ${actual[index]} vs ${expected[index]}`
    );
  }
}

function assertCadenceEquivalence(
  track: PoseTrack,
  tolerances: {
    readonly direction: number;
    readonly metres: number;
    /** Acceptance timing is always exact; resolved flight time follows the path. */
    readonly seconds?: number;
  }
): void {
  const reference = runCadence(30, track);
  assert.equal(reference.spawns.length, ROUNDS);
  assert.equal(reference.results.length, ROUNDS);

  for (const hz of [60, 144]) {
    const candidate = runCadence(hz, track);
    assert.equal(candidate.spawns.length, reference.spawns.length, `${hz} Hz round count`);
    assert.equal(candidate.results.length, reference.results.length, `${hz} Hz result count`);

    for (let index = 0; index < reference.spawns.length; index += 1) {
      const expected = reference.spawns[index];
      const actual = candidate.spawns[index];
      assert.equal(actual.sequence, expected.sequence, `${hz} Hz sequence ${index}`);
      assert.ok(
        Math.abs(actual.atSeconds - expected.atSeconds) < 1e-9,
        `${hz} Hz acceptance time ${index}: ${actual.atSeconds} vs ${expected.atSeconds}`
      );
      assertClose(actual.origin, expected.origin, tolerances.metres, `${hz} Hz origin ${index}`);
      assertClose(actual.sight, expected.sight, tolerances.direction, `${hz} Hz sight ${index}`);
      assertClose(actual.bore, expected.bore, tolerances.direction, `${hz} Hz bore ${index}`);
      assertClose(
        actual.projectile,
        expected.projectile,
        tolerances.direction,
        `${hz} Hz projectile ${index}`
      );
    }

    for (let index = 0; index < reference.results.length; index += 1) {
      const expected = reference.results[index];
      const actual = candidate.results[index];
      assert.equal(actual.sequence, expected.sequence, `${hz} Hz result sequence ${index}`);
      assert.ok(
        Math.abs(actual.flightTimeSeconds - expected.flightTimeSeconds) <=
          (tolerances.seconds ?? 1e-9),
        `${hz} Hz flight time ${index}: ${actual.flightTimeSeconds} vs ${expected.flightTimeSeconds}`
      );
      for (const [label, left, right] of [
        ["path length", actual.pathLengthMetres, expected.pathLengthMetres],
        ["drop", actual.verticalDropMetres, expected.verticalDropMetres],
        ["drift", actual.lateralDriftMetres, expected.lateralDriftMetres],
      ] as const) {
        assert.ok(
          Math.abs(left - right) <= tolerances.metres,
          `${hz} Hz ${label} ${index}: ${left} vs ${right}`
        );
      }
      assertClose(
        actual.finalPoint,
        expected.finalPoint,
        tolerances.metres,
        `${hz} Hz final point ${index}`
      );
    }
  }
}

test("the firing timeline resolves every accepted round at its own cadence boundary", () => {
  const run = runCadence(30, MOVING_AND_TURNING);
  assert.equal(run.spawns.length, ROUNDS);
  assert.equal(run.results.length, ROUNDS);

  const perFrame = new Map<number, SpawnRecord[]>();
  for (const spawn of run.spawns) {
    const bucket = perFrame.get(spawn.frameIndex) ?? [];
    bucket.push(spawn);
    perFrame.set(spawn.frameIndex, bucket);
  }
  const multiRoundFrames = [...perFrame.values()].filter((bucket) => bucket.length > 1);
  assert.ok(multiRoundFrames.length > 0, "30 Hz must cross several cadence boundaries per frame");

  for (const bucket of multiRoundFrames) {
    for (let index = 1; index < bucket.length; index += 1) {
      const previous = new THREE.Vector3().fromArray(bucket[index - 1].origin);
      const current = new THREE.Vector3().fromArray(bucket[index].origin);
      // One end-of-frame origin for the whole frame would make these equal.
      assert.ok(
        current.distanceTo(previous) > 0.02,
        "rounds accepted in one frame must spawn from distinct interpolated origins"
      );
      assert.ok(
        bucket[index].atSeconds > bucket[index - 1].atSeconds,
        "accepted rounds must stay chronological"
      );
    }
  }

  const first = run.spawns[0];
  const sight = new THREE.Vector3().fromArray(first.sight);
  const bore = new THREE.Vector3().fromArray(first.bore);
  const projectile = new THREE.Vector3().fromArray(first.projectile);
  assert.ok(sight.angleTo(bore) > 1e-4, "the turret must move the mean bore off the sightline");
  assert.ok(
    bore.angleTo(projectile) > 1e-6,
    "dispersion must move the projectile off the mean bore"
  );
  for (const direction of [sight, bore, projectile]) {
    assert.ok(Math.abs(direction.length() - 1) < 1e-12);
  }
});

test("the resolved trace keeps sight, mean bore, and projectile directions distinct", () => {
  const weapon = new WeaponSystem(RAPID_DEFINITION, 99);
  const loadout = new LoadoutSystem([{ inputSlot: 1, id: "primary", weapon }], "primary");
  const ballistics = new BallisticProjectileSystem(MISS_QUERY, environment(), { capacity: 4 });
  const timeline = new FiringTimeline({
    ballistics,
    sway: new AimSwayController(),
    sightAdjustmentFor: () => SIGHT_ADJUSTMENT,
  });
  const frame = createFiringTimelineFrame();
  const scratchPosition = new THREE.Vector3();
  const scratchOrientation = new THREE.Quaternion();
  const delta = 1 / 60;
  frame.deltaSeconds = delta;
  frame.captureTrace = true;
  frame.startPosition.copy(MOVING_AND_TURNING.position(0, scratchPosition));
  frame.endPosition.copy(MOVING_AND_TURNING.position(delta, scratchPosition));
  frame.startOrientation.copy(MOVING_AND_TURNING.orientation(0, scratchOrientation));
  frame.endOrientation.copy(MOVING_AND_TURNING.orientation(delta, scratchOrientation));

  loadout.handleCommand({ type: "triggerDown" });
  loadout.setHandlingContext({
    stance: "stand",
    grounded: true,
    planarSpeedMetresPerSecond: MOVING_AND_TURNING.planarSpeedMetresPerSecond,
    breathStabilization: 0,
  });
  loadout.update(delta);

  let spawned: { sight: THREE.Vector3; bore: THREE.Vector3; projectile: THREE.Vector3 } | null =
    null;
  timeline.runFrame(frame, loadout, {
    onShot: (shot) => {
      spawned = {
        sight: shot.sightDirection.clone(),
        bore: shot.boreDirection.clone(),
        projectile: shot.projectileDirection.clone(),
      };
    },
  });
  assert.ok(spawned);

  let trace = null;
  for (let step = 0; step < 240 && !trace; step += 1) {
    ballistics.update(delta);
    ballistics.drainResults((result) => {
      trace = result.trace;
    });
  }
  assert.ok(trace);

  assert.ok(trace.sightDirection.distanceTo(spawned.sight) < 1e-12);
  assert.ok(trace.boreDirection.distanceTo(spawned.bore) < 1e-12);
  assert.ok(trace.initialDirection.distanceTo(spawned.projectile) < 1e-12);
  // The debug view draws all three. Collapsing bore onto the dispersed
  // direction would report random spread as scope elevation and windage.
  assert.ok(trace.sightDirection.angleTo(trace.boreDirection) > 1e-4);
  assert.ok(trace.boreDirection.angleTo(trace.initialDirection) > 1e-6);
  assert.ok(trace.sightDirection.angleTo(trace.initialDirection) > 1e-4);
});

test("a stationary shooter's accepted rounds are identical at 30, 60, and 144 Hz", () => {
  // With one fixed pose there is nothing to interpolate, so this isolates the
  // timeline itself: weapon cadence cursor, sliced sway, and sliced projectile
  // stepping must all be exact functions of absolute time.
  assertCadenceEquivalence(STATIONARY, { direction: 1e-12, metres: 1e-9 });
});

test("a moving, single-axis-turning shooter stays equivalent to floating point", () => {
  // A great-circle look path leaves only THREE's slerp numerical error, roughly
  // 3e-8 rad on these arcs. The 1e-6 tolerance is 30x that and still five
  // orders below the whole-frame error this test exists to catch.
  assertCadenceEquivalence(MOVING_AND_TURNING, { direction: 1e-6, metres: 1e-3 });
});

test("a combined-axis flick diverges only by the bounded interpolation residual", () => {
  // Yaw and pitch both sweeping bends the true path away from the interpolated
  // arc, so this divergence is real rather than floating point. Worst measured
  // on this track (5.7 deg yaw + 2.3 deg pitch per 30 Hz frame, 40 rounds):
  // 3.3e-4 rad of direction and 1.4 cm of impact position. The bounds sit just
  // above that, so growth fails the test instead of quietly widening. Doc 10
  // records the same measurements.
  assertCadenceEquivalence(FLICKING, { direction: 5e-4, metres: 1e-1, seconds: 1e-3 });
});

test("the simulation clock is clamped once for the whole gameplay path", () => {
  assert.equal(clampSimulationDelta(1 / 60), 1 / 60);
  assert.equal(clampSimulationDelta(5), MAX_SIMULATION_FRAME_SECONDS);
  assert.equal(clampSimulationDelta(Number.NaN), 0);
  assert.equal(clampSimulationDelta(-1), 0);
});
