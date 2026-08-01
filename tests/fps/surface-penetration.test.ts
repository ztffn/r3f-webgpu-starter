import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Object3D, Vector3 } from "three/webgpu";
import {
  BallisticProjectileSystem,
  type BallisticResult,
} from "../../src/fps/combat/BallisticProjectileSystem.ts";
import type { BallisticEnvironment } from "../../src/fps/combat/BallisticEnvironment.ts";
import { HealthDamageable } from "../../src/fps/combat/Damageable.ts";
import { resolvePenetration } from "../../src/fps/combat/PenetrationResolver.ts";
import { SURFACE_PROFILES, type SurfaceId } from "../../src/fps/combat/SurfaceProfile.ts";
import type { WorldQuery } from "../../src/fps/core/WorldQuery.ts";
import {
  AMMUNITION_DEFINITIONS,
  type AmmunitionId,
} from "../../src/fps/weapons/AmmunitionDefinition.ts";

const STILL: BallisticEnvironment = {
  gravity: { x: 0, y: 0, z: 0 },
  windVelocity: { x: 0, y: 0, z: 0 },
  fixedStepSeconds: 1 / 120,
  maxCatchUpSeconds: 0.25,
};

function outcome(ammunitionId: AmmunitionId, surfaceId: SurfaceId, thicknessMetres: number) {
  const ammunition = AMMUNITION_DEFINITIONS[ammunitionId];
  return resolvePenetration({
    ammunition,
    surface: SURFACE_PROFILES[surfaceId],
    speedMetresPerSecond: ammunition.muzzleVelocityMetresPerSecond,
    thicknessMetres,
    incidenceCosine: 1,
  });
}

test("representative ammunition profiles distinguish concealment, cover, and armor", () => {
  for (const ammunitionId of ["9mm", "556", "308", "50bmg"] as const) {
    assert.equal(outcome(ammunitionId, "cloth", 0.012).outcome, "penetrated");
  }
  assert.equal(outcome("9mm", "wood", 0.06).outcome, "stopped");
  assert.equal(outcome("556", "wood", 0.06).outcome, "penetrated");
  assert.equal(outcome("9mm", "sheet-metal", 0.003).outcome, "stopped");
  assert.equal(outcome("556", "sheet-metal", 0.003).outcome, "penetrated");
  assert.equal(outcome("308", "armored-metal", 0.012).outcome, "stopped");
  assert.equal(outcome("50bmg", "armored-metal", 0.012).outcome, "penetrated");
});

test("invalid collider thickness fails closed instead of granting free penetration", () => {
  const ammunition = AMMUNITION_DEFINITIONS["50bmg"];
  const result = resolvePenetration({
    ammunition,
    surface: SURFACE_PROFILES.cloth,
    speedMetresPerSecond: ammunition.muzzleVelocityMetresPerSecond,
    thicknessMetres: Number.NaN,
    incidenceCosine: 1,
  });
  assert.equal(result.outcome, "stopped");
  assert.equal(result.speedAfterMetresPerSecond, 0);
});

function runPenetration(frameDeltaSeconds: number) {
  const cover = new Object3D();
  cover.name = "cloth-cover";
  const targetObject = new Object3D();
  targetObject.name = "downstream-target";
  const target = new HealthDamageable("downstream-target", 100);
  const query: WorldQuery = {
    raycast(origin, direction, maxDistance) {
      const plane = origin.z > -10.001 ? -10 : -15;
      if (origin.z <= -15.001 || direction.z >= 0) return null;
      const distance = (plane - origin.z) / direction.z;
      if (distance < 0 || distance > maxDistance) return null;
      const isCover = plane === -10;
      return {
        distance,
        point: new Vector3(origin.x, origin.y, plane),
        normal: new Vector3(0, 0, 1),
        kind: isCover ? "world" : "target",
        objectId: isCover ? "cloth-cover" : "downstream-target",
        surfaceId: isCover ? "cloth" : "flesh",
        penetrationThicknessMetres: isCover ? 0.012 : 0.24,
        damageable: isCover ? null : target,
        object: isCover ? cover : targetObject,
      };
    },
  };
  const system = new BallisticProjectileSystem(query, STILL, { capacity: 1 });
  const ammunition = AMMUNITION_DEFINITIONS["556"];
  assert.equal(
    system.spawn({
      sourceId: "penetration-test",
      sequence: 1,
      origin: new Vector3(),
      direction: new Vector3(0, 0, -1),
      maxDistance: 30,
      damage: ammunition.baseDamage,
      ammunition,
    }),
    true
  );
  let result: BallisticResult | null = null;
  for (let frame = 0; frame < 240 && !result; frame += 1) {
    system.update(frameDeltaSeconds);
    system.drainImpactEvents(() => {});
    system.drainResults((next) => {
      result = next;
    });
  }
  assert.ok(result);
  return { result, health: target.health, metrics: system.getMetrics() };
}

test("one live projectile penetrates cloth and damages the target behind it", () => {
  const at60 = runPenetration(1 / 60);
  assert.ok(at60.health < 100);
  assert.deepEqual(
    at60.result.trace.interactions.map((interaction: { surfaceId: string }) => interaction.surfaceId),
    ["cloth", "flesh"]
  );
  assert.equal(at60.result.reports[0]?.targetId, "downstream-target");
  assert.equal(at60.metrics.surfaceInteractions, 2);
});

test("penetration and downstream damage remain render-frame independent", () => {
  const at30 = runPenetration(1 / 30);
  const at144 = runPenetration(1 / 144);
  assert.equal(at144.health, at30.health);
  assert.deepEqual(
    at144.result.trace.interactions.map((interaction: { surfaceId: string; outcome: string }) => [
      interaction.surfaceId,
      interaction.outcome,
    ]),
    at30.result.trace.interactions.map((interaction: { surfaceId: string; outcome: string }) => [
      interaction.surfaceId,
      interaction.outcome,
    ])
  );
});

test("32-player 900 RPM cloth-impact load remains bounded", () => {
  const cover = new Object3D();
  cover.name = "load-cloth";
  const query: WorldQuery = {
    raycast(origin, direction, maxDistance) {
      if (origin.z <= -10.001 || direction.z >= 0) return null;
      const distance = (-10 - origin.z) / direction.z;
      if (distance < 0 || distance > maxDistance) return null;
      return {
        distance,
        point: new Vector3(origin.x, origin.y, -10),
        normal: new Vector3(0, 0, 1),
        kind: "world",
        objectId: "load-cloth",
        surfaceId: "cloth",
        penetrationThicknessMetres: 0.012,
        damageable: null,
        object: cover,
      };
    },
  };
  const system = new BallisticProjectileSystem(query, STILL, {
    capacity: 2_048,
    maxTracePoints: 2,
  });
  const ammunition = AMMUNITION_DEFINITIONS["556"];
  const roundsPerSecond = (32 * 900) / 60;
  const frameDelta = 1 / 60;
  let sequence = 0;
  let drainedImpacts = 0;
  const started = performance.now();
  for (let frame = 0; frame < 5 / frameDelta; frame += 1) {
    const expected = Math.floor((frame + 1) * frameDelta * roundsPerSecond + 1e-9);
    while (sequence < expected) {
      sequence += 1;
      assert.equal(
        system.spawn({
          sourceId: `load-${sequence % 32}`,
          sequence,
          origin: new Vector3(),
          direction: new Vector3(0, 0, -1),
          maxDistance: 100,
          damage: ammunition.baseDamage,
          ammunition,
          captureTrace: false,
        }),
        true
      );
    }
    system.update(frameDelta);
    system.drainImpactEvents(() => {
      drainedImpacts += 1;
    });
    system.drainResults(() => {});
  }
  while (system.getMetrics().active > 0) {
    system.update(frameDelta);
    system.drainImpactEvents(() => {
      drainedImpacts += 1;
    });
    system.drainResults(() => {});
  }
  const metrics = system.getMetrics();
  assert.equal(metrics.spawned, 2_400);
  assert.equal(metrics.surfaceInteractions, 2_400);
  assert.equal(drainedImpacts, 2_400);
  assert.equal(metrics.rejectedSpawns, 0);
  assert.equal(metrics.droppedImpactEvents, 0);
  assert.ok(metrics.peakActive < 2_048);
  console.info("penetration load metrics", {
    ...metrics,
    cpuMilliseconds: Number((performance.now() - started).toFixed(1)),
  });
});
