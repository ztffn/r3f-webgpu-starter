import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three/webgpu";
import { ThreeWorldQuery } from "../../src/fps/core/WorldQuery.ts";
import { createWorldObjectInstance } from "../../src/fps/world/WorldObjectPrefab.ts";

test("world-object prefab registers authored surface and simplified thickness", () => {
  const query = new ThreeWorldQuery();
  const instance = createWorldObjectInstance({
    id: "test-cloth",
    kind: "world",
    surfaceId: "cloth",
    collider: {
      width: 2,
      height: 2,
      depth: 0.02,
      penetrationThicknessMetres: 0.012,
    },
    visual: { color: 0x777777 },
  });
  instance.root.position.set(0, 0, -10);
  const unregister = instance.register(query);
  const hit = query.raycast(new Vector3(0, 0, 0), new Vector3(0, 0, -1), 20);
  assert.equal(hit?.objectId, "test-cloth");
  assert.equal(hit?.surfaceId, "cloth");
  assert.equal(hit?.penetrationThicknessMetres, 0.012);
  unregister();
  assert.equal(query.raycast(new Vector3(), new Vector3(0, 0, -1), 20), null);
  instance.dispose();
});

test("optional prefab health performs one intact-to-husk transition and resets", () => {
  const instance = createWorldObjectInstance({
    id: "destructible-target",
    kind: "target",
    surfaceId: "flesh",
    collider: { width: 1, height: 2, depth: 0.2, penetrationThicknessMetres: 0.2 },
    visual: { color: 0xaa3333 },
    destructible: { maxHealth: 50, huskColor: 0x332222 },
  });
  const intact = instance.root.getObjectByName("destructible-target-intact")!;
  const husk = instance.root.getObjectByName("destructible-target-husk")!;
  instance.damageable!.applyDamage({
    amount: 50,
    point: new Vector3(),
    direction: new Vector3(0, 0, -1),
    sourceId: "test",
    shotSequence: 1,
  });
  assert.equal(intact.visible, false);
  assert.equal(husk.visible, true);
  instance.damageable!.reset();
  assert.equal(intact.visible, true);
  assert.equal(husk.visible, false);
  instance.dispose();
});
