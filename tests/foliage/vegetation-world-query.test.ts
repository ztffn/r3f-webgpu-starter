import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three/webgpu";
import { VegetationField, type VegetationTerrain } from "../../src/foliage/VegetationField.ts";
import { VegetationWorldQuery } from "../../src/foliage/VegetationWorldQuery.ts";
import { CompositeWorldQuery } from "../../src/fps/core/WorldQuery.ts";
import { SPECIES } from "../../src/foliage/species.ts";

const WORLD_SIZE = 2048;

const FLAT: VegetationTerrain = {
  worldSize: WORLD_SIZE,
  halfWorld: WORLD_SIZE / 2,
  sample: () => 0,
  normal: (_x, _z, out = [0, 1, 0]) => {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return out;
  },
};

const ACACIA = SPECIES.find((species) => species.id === "acacia");
if (!ACACIA?.trunk) throw new Error("test fixture expects a species with a trunk");
const TRUNK = ACACIA.trunk;

/** Finds a placed trunk to aim at, so the test is not asserting against an empty map. */
function findTrunk(field: VegetationField): { x: number; z: number; base: number; scale: number } {
  const acaciaIndex = SPECIES.findIndex((species) => species.id === "acacia");
  for (let cz = 0; cz < 24; cz += 1) {
    for (let cx = 0; cx < 24; cx += 1) {
      const cell = field.cell(cx, cz);
      const [start, count] = cell.speciesRanges[acaciaIndex];
      if (count === 0) continue;
      return {
        x: field.cellOrigin(cx) + cell.offsetX[start],
        z: field.cellOrigin(cz) + cell.offsetZ[start],
        base: cell.baseY[start],
        scale: cell.scale[start],
      };
    }
  }
  throw new Error("no acacia placed on a flat test map");
}

test("a ray through a trunk reports a wood hit at the trunk's face", () => {
  const field = new VegetationField({ terrain: FLAT, cellSize: 32, density: 1 });
  const query = new VegetationWorldQuery(field);
  const trunk = findTrunk(field);
  const radius = TRUNK.radiusMetres * trunk.scale;

  const origin = new Vector3(trunk.x - 20, trunk.base + 1, trunk.z);
  const hit = query.raycast(origin, new Vector3(1, 0, 0), 100);

  assert.ok(hit, "expected a trunk hit");
  assert.equal(hit.surfaceId, "wood");
  assert.equal(hit.kind, "world");
  assert.ok(Math.abs(hit.distance - (20 - radius)) < 1e-3, `hit at ${hit.distance}`);
  // Normal points back out of the trunk, radially.
  assert.ok(hit.normal !== null && Math.abs(hit.normal.x + 1) < 1e-3);
});

test("a ray over the crown and a ray under the ground both miss", () => {
  const field = new VegetationField({ terrain: FLAT, cellSize: 32, density: 1 });
  const query = new VegetationWorldQuery(field);
  const trunk = findTrunk(field);
  const above = trunk.base + TRUNK.heightMetres * trunk.scale + 1;

  assert.equal(
    query.raycast(new Vector3(trunk.x - 20, above, trunk.z), new Vector3(1, 0, 0), 100),
    null
  );
  assert.equal(
    query.raycast(new Vector3(trunk.x - 20, trunk.base - 1, trunk.z), new Vector3(1, 0, 0), 100),
    null
  );
});

test("penetration thickness scales with the instance, so trunks are not interchangeable", () => {
  const field = new VegetationField({ terrain: FLAT, cellSize: 32, density: 1 });
  const query = new VegetationWorldQuery(field);
  const trunk = findTrunk(field);
  const hit = query.raycast(
    new Vector3(trunk.x - 12, trunk.base + 1, trunk.z),
    new Vector3(1, 0, 0),
    50
  );
  assert.ok(hit);
  assert.ok(
    Math.abs(hit.penetrationThicknessMetres - TRUNK.penetrationThicknessMetres * trunk.scale) < 1e-6
  );
});

test("the object id is derived from the wrapped cell, so tile repeats name the same tree", () => {
  const field = new VegetationField({ terrain: FLAT, cellSize: 32, density: 1 });
  const query = new VegetationWorldQuery(field);
  const trunk = findTrunk(field);
  const near = query.raycast(
    new Vector3(trunk.x - 5, trunk.base + 1, trunk.z),
    new Vector3(1, 0, 0),
    20
  );
  const repeat = query.raycast(
    new Vector3(trunk.x - 5 + WORLD_SIZE, trunk.base + 1, trunk.z),
    new Vector3(1, 0, 0),
    20
  );
  assert.ok(near && repeat);
  assert.equal(near.objectId, repeat.objectId);
  assert.ok(near.objectId.startsWith("vegetation:acacia:"));
});

test("composed with terrain, the nearer of the two wins", () => {
  const field = new VegetationField({ terrain: FLAT, cellSize: 32, density: 1 });
  const trunk = findTrunk(field);
  const composite = new CompositeWorldQuery({
    cellSize: 1,
    halfWorld: 0,
    minHeight: 0,
    maxHeight: 0,
    sample: () => 0,
    normal: (_x, _z, out = [0, 1, 0]) => {
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
      return out;
    },
  });
  composite.addSource(new VegetationWorldQuery(field));

  // Level shot at 1 m: the ground is never crossed, so the trunk must be the hit.
  const level = composite.raycast(
    new Vector3(trunk.x - 15, 1, trunk.z),
    new Vector3(1, 0, 0),
    60
  );
  assert.equal(level?.kind, "world");
  assert.equal(level?.surfaceId, "wood");

  // Steeply downward from the same spot: the ground is nearer than any trunk.
  const down = composite.raycast(
    new Vector3(trunk.x - 15, 1, trunk.z),
    new Vector3(0.05, -1, 0),
    60
  );
  assert.equal(down?.kind, "terrain");
});

test("unregistering a source removes it from the composition", () => {
  const field = new VegetationField({ terrain: FLAT, cellSize: 32, density: 1 });
  const trunk = findTrunk(field);
  const composite = new CompositeWorldQuery(null);
  const remove = composite.addSource(new VegetationWorldQuery(field));
  assert.ok(composite.raycast(new Vector3(trunk.x - 10, 1, trunk.z), new Vector3(1, 0, 0), 40));
  remove();
  assert.equal(
    composite.raycast(new Vector3(trunk.x - 10, 1, trunk.z), new Vector3(1, 0, 0), 40),
    null
  );
});
