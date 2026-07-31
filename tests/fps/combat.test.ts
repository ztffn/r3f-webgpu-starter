import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three/webgpu";
import { HealthDamageable } from "../../src/fps/combat/Damageable.ts";
import { HitscanResolver } from "../../src/fps/combat/HitscanResolver.ts";
import type { WorldQuery } from "../../src/fps/core/WorldQuery.ts";
import { ShotDebugStore } from "../../src/fps/debug/ShotDebugStore.ts";
import { CombatTelemetry } from "../../src/fps/ui/CombatTelemetry.ts";

test("hitscan resolves against world query and applies target damage", () => {
  const target = new HealthDamageable("target", 100);
  const query: WorldQuery = {
    raycast: () => ({
      distance: 42,
      point: new Vector3(0, 1, -42),
      normal: new Vector3(0, 0, 1),
      kind: "target",
      damageable: target,
      object: { name: "target-mesh" } as never,
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
  assert.deepEqual(result.trace.points[1].toArray(), [0, 1, -42]);
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
  assert.deepEqual(result.trace.points[1].toArray(), [0, 0, -100]);
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
  assert.equal(telemetry.getSnapshot().lastShot?.targetId, null);
  assert.equal(debug.getSnapshot().trace?.shotSequence, 6);
  assert.equal(notifications, 6);
  debug.clear();
  assert.equal(debug.getSnapshot().trace, null);
  assert.equal(notifications, 7);
  unsubscribe();
});
