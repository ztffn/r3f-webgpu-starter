import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three/webgpu";
import { HealthDamageable } from "../../src/fps/combat/Damageable.ts";
import { HitscanResolver } from "../../src/fps/combat/HitscanResolver.ts";
import type { WorldQuery } from "../../src/fps/core/WorldQuery.ts";

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
});
