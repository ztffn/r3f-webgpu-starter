import assert from "node:assert/strict";
import test from "node:test";
import { VegetationField, type VegetationTerrain } from "../../src/foliage/VegetationField.ts";
import { SPECIES } from "../../src/foliage/species.ts";

const WORLD_SIZE = 2048;

function flatTerrain(
  height: (x: number, z: number) => number = () => 10,
  normalY = 1
): VegetationTerrain {
  return {
    worldSize: WORLD_SIZE,
    halfWorld: WORLD_SIZE / 2,
    sample: (x, z) => height(x, z),
    normal: (_x, _z, out = [0, 1, 0]) => {
      out[0] = 0;
      out[1] = normalY;
      out[2] = 0;
      return out;
    },
  };
}

function field(overrides: Partial<ConstructorParameters<typeof VegetationField>[0]> = {}) {
  return new VegetationField({ terrain: flatTerrain(), cellSize: 32, ...overrides });
}

test("cell size is snapped so a whole number of cells spans one tile", () => {
  // 30 does not divide 2048; the field must not silently accept a fractional cell count,
  // because the wrapped cell index would stop meaning anything and placement would seam
  // at the tile repeat.
  const snapped = field({ cellSize: 30 });
  assert.equal(Number.isInteger(snapped.cellsPerTile), true);
  assert.equal(snapped.cellsPerTile * snapped.cellSize, WORLD_SIZE);
});

test("placement repeats with the terrain tile", () => {
  const vegetation = field();
  const near = vegetation.cell(3, 5);
  const repeat = vegetation.cell(3 + vegetation.cellsPerTile, 5 - 2 * vegetation.cellsPerTile);
  assert.equal(near, repeat, "a wrapped repeat must resolve to the same cached record");
});

test("a cell is a pure function of its wrapped index", () => {
  const a = field();
  const b = field();
  const left = a.cell(-7, 12);
  const right = b.cell(-7, 12);
  assert.equal(left.count, right.count);
  assert.deepEqual(Array.from(left.offsetX), Array.from(right.offsetX));
  assert.deepEqual(Array.from(left.rotationY), Array.from(right.rotationY));
  assert.deepEqual(Array.from(left.seed), Array.from(right.seed));
});

test("a different map seed reshuffles the map", () => {
  const a = field({ mapSeed: 1 }).cell(2, 2);
  const b = field({ mapSeed: 2 }).cell(2, 2);
  const same =
    a.count === b.count &&
    Array.from(a.offsetX).every((value, index) => value === b.offsetX[index]);
  assert.equal(same, false);
});

test("plants stay inside their own cell and stand on the ground", () => {
  const terrain = flatTerrain((x, z) => 20 + Math.sin(x * 0.01) * 3 + z * 0.001);
  const vegetation = field({ terrain });
  for (let cz = 0; cz < 4; cz += 1) {
    for (let cx = 0; cx < 4; cx += 1) {
      const cell = vegetation.cell(cx, cz);
      for (let i = 0; i < cell.count; i += 1) {
        assert.ok(cell.offsetX[i] >= 0 && cell.offsetX[i] < vegetation.cellSize);
        assert.ok(cell.offsetZ[i] >= 0 && cell.offsetZ[i] < vegetation.cellSize);
        const worldX = vegetation.cellOrigin(cx) + cell.offsetX[i];
        const worldZ = vegetation.cellOrigin(cz) + cell.offsetZ[i];
        assert.ok(
          Math.abs(cell.baseY[i] - terrain.sample(worldX, worldZ)) < 1e-4,
          "base must sit on the sampled ground"
        );
      }
    }
  }
});

test("species ranges partition the cell exactly", () => {
  const vegetation = field();
  const cell = vegetation.cell(9, 4);
  let cursor = 0;
  for (const [start, count] of cell.speciesRanges) {
    assert.equal(start, cursor);
    cursor += count;
  }
  assert.equal(cursor, cell.count);
});

test("nothing grows below the waterline", () => {
  const level = 12;
  const vegetation = field({
    terrain: flatTerrain((x) => (x < 0 ? level - 5 : level + 5)),
    waterHeight: level,
  });
  let dry = 0;
  for (let cx = -6; cx < 6; cx += 1) {
    const cell = vegetation.cell(cx, 0);
    for (let i = 0; i < cell.count; i += 1) {
      assert.ok(cell.baseY[i] > level, "a plant was placed below the waterline");
      dry += 1;
    }
  }
  assert.ok(dry > 0, "the fixture produced no plants at all, so it proves nothing");
});

test("steep ground rejects the species that require flat ground", () => {
  const steep = new VegetationField({ terrain: flatTerrain(() => 40, 0.5), cellSize: 32 });
  const cell = steep.cell(1, 1);
  const acacia = SPECIES.findIndex((s) => s.id === "acacia");
  assert.equal(cell.speciesRanges[acacia][1], 0, "acacia needs flat ground");
});

test("density scales the population without moving the survivors", () => {
  const sparse = field({ density: 0.25 }).cell(5, 5);
  const dense = field({ density: 1 }).cell(5, 5);
  assert.ok(dense.count > sparse.count);
});

test("the cell cache is bounded by one tile", () => {
  const vegetation = field();
  for (let i = 0; i < 500; i += 1) vegetation.cell(i, i * 3);
  assert.ok(vegetation.cachedCellCount <= vegetation.cellsPerTile ** 2);
});
