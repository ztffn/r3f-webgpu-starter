import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Object3D, Vector3 } from "three/webgpu";
import {
  BallisticProjectileSystem,
  type BallisticResult,
} from "../../src/fps/combat/BallisticProjectileSystem.ts";
import {
  readBallisticEnvironment,
  type BallisticEnvironment,
} from "../../src/fps/combat/BallisticEnvironment.ts";
import { HealthDamageable } from "../../src/fps/combat/Damageable.ts";
import type { WorldQuery } from "../../src/fps/core/WorldQuery.ts";

const MISS_QUERY: WorldQuery = { raycast: () => null };
const BASE_SHOT = {
  sourceId: "sniper",
  sequence: 1,
  origin: new Vector3(0, 100, 0),
  direction: new Vector3(0, 0, -1),
  damage: 100,
  muzzleVelocityMetresPerSecond: 792.48,
  ballisticCoefficientG1: 0.505,
} as const;

function environment(windX = 0): BallisticEnvironment {
  return {
    gravity: { x: 0, y: -9.80665, z: 0 },
    windVelocity: { x: windX, y: 0, z: 0 },
    fixedStepSeconds: 1 / 120,
    maxCatchUpSeconds: 0.25,
  };
}

function resolveMiss(range: number, windX = 0, frameDelta = 1 / 60): BallisticResult {
  const system = new BallisticProjectileSystem(MISS_QUERY, environment(windX), {
    capacity: 4,
  });
  assert.equal(system.spawn({ ...BASE_SHOT, maxDistance: range }), true);
  let result: BallisticResult | null = null;
  for (let frame = 0; frame < 2_000 && !result; frame += 1) {
    system.update(frameDelta);
    system.drainResults((next) => {
      result = next;
    });
  }
  assert.ok(result, `shot at ${range} m did not resolve`);
  return result;
}

test("drop and flight time increase through the 1,300 m acceptance ladder", () => {
  const ranges = [100, 300, 600, 1_000, 1_300];
  const results = ranges.map((range) => resolveMiss(range));
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[i].trace.flightTimeSeconds > results[i - 1].trace.flightTimeSeconds);
    assert.ok(results[i].trace.verticalDropMetres > results[i - 1].trace.verticalDropMetres);
    assert.ok(results[i].trace.impactSpeedMetresPerSecond! < results[i - 1].trace.impactSpeedMetresPerSecond!);
  }
  assert.equal(results.at(-1)?.trace.mode, "ballistic");
  assert.ok(results.at(-1)!.trace.points.length > 200, "debug trace retains the simulated curve");
});

test("equal opposite crosswinds produce equal opposite drift", () => {
  const positive = resolveMiss(1_300, 4);
  const negative = resolveMiss(1_300, -4);
  assert.ok(positive.trace.lateralDriftMetres > 0);
  assert.ok(negative.trace.lateralDriftMetres < 0);
  assert.ok(
    Math.abs(positive.trace.lateralDriftMetres + negative.trace.lateralDriftMetres) < 1e-6
  );
});

test("fixed-step outcome is independent of render-frame cadence", () => {
  const at30 = resolveMiss(1_300, 4, 1 / 30).trace;
  const at60 = resolveMiss(1_300, 4, 1 / 60).trace;
  const at144 = resolveMiss(1_300, 4, 1 / 144).trace;
  for (const candidate of [at60, at144]) {
    assert.ok(Math.abs(candidate.flightTimeSeconds - at30.flightTimeSeconds) < 1e-9);
    assert.ok(Math.abs(candidate.verticalDropMetres - at30.verticalDropMetres) < 1e-9);
    assert.ok(Math.abs(candidate.lateralDriftMetres - at30.lateralDriftMetres) < 1e-9);
    assert.deepEqual(candidate.points.at(-1)?.toArray(), at30.points.at(-1)?.toArray());
  }
});

test("ballistic trace preserves separate optical sight and adjusted bore directions", () => {
  const system = new BallisticProjectileSystem(MISS_QUERY, environment(), { capacity: 1 });
  const bore = new Vector3(0.001, 0.01, -1).normalize();
  const sight = new Vector3(0, 0, -1);
  system.spawn({ ...BASE_SHOT, direction: bore, sightDirection: sight, maxDistance: 100 });
  let result: BallisticResult | null = null;
  while (!result) {
    system.update(1 / 60);
    system.drainResults((next) => {
      result = next;
    });
  }
  assert.deepEqual(result.trace.sightDirection.toArray(), sight.toArray());
  assert.ok(result.trace.initialDirection.angleTo(bore) < 1e-9);
});

test("swept collision delays damage until the projectile reaches a thin target", () => {
  const target = new HealthDamageable("thin-target", 100);
  const object = new Object3D();
  object.name = "thin-target-mesh";
  const query: WorldQuery = {
    raycast(origin, direction, maxDistance) {
      if (direction.z >= 0 || origin.z < -10) return null;
      const distance = (-10 - origin.z) / direction.z;
      if (distance < 0 || distance > maxDistance) return null;
      return {
        distance,
        point: new Vector3(
          origin.x + direction.x * distance,
          origin.y + direction.y * distance,
          -10
        ),
        normal: new Vector3(0, 0, 1),
        kind: "target",
        damageable: target,
        object,
      };
    },
  };
  const system = new BallisticProjectileSystem(query, environment(), { capacity: 2 });
  system.spawn({ ...BASE_SHOT, maxDistance: 100 });
  assert.equal(target.health, 100, "trigger acceptance does not apply damage");
  system.update(1 / 120);
  assert.equal(target.health, 100, "first swept segment has not reached 10 m");
  system.update(1 / 120);
  assert.equal(target.health, 0, "second swept segment crosses and damages the target");
  let result: BallisticResult | null = null;
  system.drainResults((next) => {
    result = next;
  });
  assert.equal(result?.report?.targetId, "thin-target");
  assert.equal(result?.trace.impact?.targetId, "thin-target");
  assert.ok(result!.trace.flightTimeSeconds > 0);
});

test("pool exhaustion rejects explicitly without replacing a live projectile", () => {
  const system = new BallisticProjectileSystem(MISS_QUERY, environment(), { capacity: 1 });
  assert.equal(system.spawn({ ...BASE_SHOT, maxDistance: 1_300 }), true);
  assert.equal(system.spawn({ ...BASE_SHOT, sequence: 2, maxDistance: 1_300 }), false);
  assert.deepEqual(system.getMetrics(), {
    active: 1,
    peakActive: 1,
    spawned: 1,
    rejectedSpawns: 1,
    completed: 0,
    fixedSteps: 0,
    segmentQueries: 0,
  });
});

test("invalid projectile data is rejected and wind query overrides stay finite", () => {
  const system = new BallisticProjectileSystem(MISS_QUERY, environment(), { capacity: 2 });
  assert.equal(
    system.spawn({ ...BASE_SHOT, direction: { x: Number.NaN, y: 0, z: -1 }, maxDistance: 100 }),
    false
  );
  assert.equal(system.getMetrics().active, 0);
  assert.equal(readBallisticEnvironment("?windx=-7.5&windz=2").windVelocity.x, -7.5);
  assert.equal(readBallisticEnvironment("?windx=nope").windVelocity.x, 4);
});

function runAutomaticLoad(shooters: number, rpm: number) {
  const system = new BallisticProjectileSystem(MISS_QUERY, environment(), {
    capacity: 2_048,
    maxTracePoints: 2,
  });
  const roundsPerSecond = (shooters * rpm) / 60;
  const frameDelta = 1 / 60;
  const firingSeconds = 5;
  let spawnAccumulator = 0;
  let sequence = 0;
  const started = performance.now();
  for (let frame = 0; frame < firingSeconds / frameDelta; frame += 1) {
    const expectedSpawned = Math.floor((frame + 1) * frameDelta * roundsPerSecond + 1e-9);
    spawnAccumulator = expectedSpawned - sequence;
    while (spawnAccumulator >= 1) {
      spawnAccumulator -= 1;
      sequence += 1;
      assert.equal(
        system.spawn({ ...BASE_SHOT, sequence, maxDistance: 1_300, captureTrace: false }),
        true
      );
    }
    system.update(frameDelta);
    system.drainResults(() => {});
  }
  while (system.getMetrics().active > 0) {
    system.update(frameDelta);
    system.drainResults(() => {});
  }
  return { ...system.getMetrics(), cpuMilliseconds: performance.now() - started };
}

test("pooled solver sustains 16/32-player automatic-fire acceptance loads", () => {
  const loads = [runAutomaticLoad(16, 600), runAutomaticLoad(32, 600), runAutomaticLoad(32, 900)];
  for (const load of loads) {
    assert.equal(load.rejectedSpawns, 0);
    assert.equal(load.active, 0);
    assert.equal(load.completed, load.spawned);
    assert.ok(load.peakActive < 2_048);
    assert.ok(load.segmentQueries > load.spawned);
  }
  console.info(
    "ballistic load metrics",
    loads.map(({ spawned, peakActive, segmentQueries, cpuMilliseconds }) => ({
      spawned,
      peakActive,
      segmentQueries,
      cpuMilliseconds: Number(cpuMilliseconds.toFixed(1)),
    }))
  );
});
