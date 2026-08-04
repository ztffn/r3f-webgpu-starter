import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three/webgpu";
import { HealthDamageable } from "../../src/combat/Damageable.ts";
import { HitscanResolver } from "../../src/fps/combat/HitscanResolver.ts";
import type { WorldQuery } from "../../src/fps/core/WorldQuery.ts";
import { ShotDebugStore } from "../../src/fps/debug/ShotDebugStore.ts";
import { CombatTelemetry } from "../../src/fps/ui/CombatTelemetry.ts";
import { ImpactEffectBus } from "../../src/fps/presentation/ImpactEffectBus.ts";

test("hitscan resolves against world query and applies target damage", () => {
  const target = new HealthDamageable("target", 100);
  const query: WorldQuery = {
    raycast: () => ({
      distance: 42,
      point: new Vector3(0, 1, -42),
      normal: new Vector3(0, 0, 1),
      kind: "target",
      objectId: "target",
      objectName: "target-mesh",
      surfaceId: "flesh",
      penetrationThicknessMetres: 0.24,
      damageable: target,
    }),
  };
  const resolver = new HitscanResolver(query);
  const result = resolver.resolve({
    sourceId: "sniper",
    sequence: 1,
    origin: new Vector3(),
    direction: new Vector3(0, 0, -1),
    maxDistance: 1_200,
    damage: 65,
  });

  assert.equal(result.hit?.distance, 42);
  assert.equal(result.damageApplied, 65);
  assert.equal(target.health, 35);
  assert.equal(result.destroyed, false);
  assert.equal(result.report?.targetId, "target");
  assert.equal(result.report?.objectName, "target-mesh");
  assert.equal(result.report?.healthBefore, 100);
  assert.equal(result.report?.healthAfter, 35);
  assert.equal(result.report?.rangeMetres, 42);
  assert.equal(result.trace.mode, "hitscan");
  assert.equal(result.trace.points.length, 2);
  assert.deepEqual(
    [result.trace.points[1].x, result.trace.points[1].y, result.trace.points[1].z],
    [0, 1, -42]
  );
  assert.equal(result.trace.impact?.targetId, "target");
  target.reset();
  assert.equal(target.health, 100);
});

test("terrain hits and misses never mutate target health", () => {
  const miss: WorldQuery = { raycast: () => null };
  const result = new HitscanResolver(miss).resolve({
    sourceId: "sniper",
    sequence: 1,
    origin: new Vector3(),
    direction: new Vector3(0, 0, -1),
    maxDistance: 100,
    damage: 100,
  });
  assert.equal(result.hit, null);
  assert.equal(result.damageApplied, 0);
  assert.equal(result.report, null);
  assert.equal(result.trace.impact, null);
  assert.deepEqual(
    [result.trace.points[1].x, result.trace.points[1].y, result.trace.points[1].z],
    [0, 0, -100]
  );
});

test("telemetry retains five reports and debug store retains only the latest trace", () => {
  const query: WorldQuery = { raycast: () => null };
  const resolver = new HitscanResolver(query);
  const telemetry = new CombatTelemetry();
  const debug = new ShotDebugStore();
  let notifications = 0;
  const unsubscribe = debug.subscribe(() => {
    notifications += 1;
  });

  for (let sequence = 1; sequence <= 6; sequence += 1) {
    const result = resolver.resolve({
      sourceId: "sniper",
      sequence,
      origin: new Vector3(),
      direction: new Vector3(1, 0, 0),
      maxDistance: 250,
      damage: 100,
    });
    telemetry.publishShot(result);
    debug.publish(result.trace);
  }

  assert.deepEqual(
    telemetry.getSnapshot().recentShots.map((shot) => shot.sequence),
    [6, 5, 4, 3, 2]
  );
  assert.equal(telemetry.getSnapshot().lastShot?.target, null);
  assert.equal(telemetry.getSnapshot().lastShot?.terminal, null);
  assert.equal(telemetry.getSnapshot().lastShot?.mode, "hitscan");
  assert.equal(debug.getSnapshot().trace?.shotSequence, 6);
  assert.equal(notifications, 6);
  debug.clear();
  assert.equal(debug.getSnapshot().trace, null);
  assert.equal(notifications, 7);
  unsubscribe();
});

test("penetrating contacts publish immediate telemetry and presentation events", () => {
  const telemetry = new CombatTelemetry();
  const bus = new ImpactEffectBus();
  let presentationEvents = 0;
  const unsubscribe = bus.subscribe(() => {
    presentationEvents += 1;
  });
  const event = {
    sourceId: "sniper",
    shotSequence: 7,
    interactionIndex: 1,
    ammunitionId: "308" as const,
    kind: "target" as const,
    objectId: "target",
    objectName: "target-mesh",
    targetId: "target",
    damageApplied: 100,
    healthBefore: 100,
    healthAfter: 0,
    destroyed: true,
    surfaceId: "flesh" as const,
    outcome: "penetrated" as const,
    point: new Vector3(0, 1, -20),
    exitPoint: new Vector3(0, 1, -20.24),
    normal: new Vector3(0, 0, 1),
    effectiveThicknessMetres: 0.24,
    speedBeforeMetresPerSecond: 780,
    speedAfterMetresPerSecond: 690,
    energyBeforeJoules: 3_450,
    energyAfterJoules: 2_700,
  };
  telemetry.publishImpact(event);
  bus.publish(event);
  assert.equal(telemetry.getSnapshot().lastImpact?.targetId, "target");
  assert.equal(telemetry.getSnapshot().lastImpact?.destroyed, true);
  assert.equal(telemetry.getSnapshot().lastShot, null, "contact does not fake shot completion");
  assert.equal(presentationEvents, 1);
  unsubscribe();
  bus.publish(event);
  assert.equal(presentationEvents, 1);
});
