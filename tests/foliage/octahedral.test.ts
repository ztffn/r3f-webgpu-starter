import assert from "node:assert/strict";
import test from "node:test";
import {
  blendViews,
  gridViewDirection,
  hemiOctDecode,
  hemiOctEncode,
  viewBasis,
} from "../../src/foliage/octahedral.ts";

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

test("encode/decode roundtrip over the upper hemisphere", () => {
  for (let a = 0; a < 64; a += 1) {
    for (let e = 0; e <= 16; e += 1) {
      const azimuth = (a / 64) * Math.PI * 2;
      const elevation = (e / 16) * (Math.PI / 2);
      const x = Math.cos(azimuth) * Math.cos(elevation);
      const y = Math.sin(elevation);
      const z = Math.sin(azimuth) * Math.cos(elevation);
      const [u, v] = hemiOctEncode(x, y, z);
      assert.ok(u >= -1.0001 && u <= 1.0001, `u in range for az ${a} el ${e}`);
      assert.ok(v >= -1.0001 && v <= 1.0001, `v in range for az ${a} el ${e}`);
      const [dx, dy, dz] = hemiOctDecode(u, v);
      assertClose(dx, x, 1e-6, `x roundtrip az ${a} el ${e}`);
      assertClose(dy, y, 1e-6, `y roundtrip az ${a} el ${e}`);
      assertClose(dz, z, 1e-6, `z roundtrip az ${a} el ${e}`);
    }
  }
});

test("the square's boundary is the horizon and its centre is the zenith", () => {
  const n = 12;
  for (let i = 0; i < n; i += 1) {
    for (const [u, w] of [
      [i, 0],
      [i, n - 1],
      [0, i],
      [n - 1, i],
    ]) {
      const direction = gridViewDirection(u, w, n);
      assertClose(direction[1], 0, 1e-6, `edge tile (${u},${w}) is a horizon view`);
    }
  }
  const zenith = hemiOctDecode(0, 0);
  assertClose(zenith[1], 1, 1e-6, "centre decodes to straight up");
});

test("every grid view has an orthonormal basis agreeing with the view", () => {
  const n = 12;
  const dot = (a: readonly number[], b: readonly number[]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const direction = gridViewDirection(i, j, n);
      const basis = viewBasis(direction);
      assertClose(dot(basis.right, basis.right), 1, 1e-6, `right unit (${i},${j})`);
      assertClose(dot(basis.up, basis.up), 1, 1e-6, `up unit (${i},${j})`);
      assertClose(dot(basis.right, basis.up), 0, 1e-6, `right ⊥ up (${i},${j})`);
      assertClose(dot(basis.right, direction), 0, 1e-6, `right ⊥ view (${i},${j})`);
      assertClose(dot(basis.up, direction), 0, 1e-6, `up ⊥ view (${i},${j})`);
      // right stays horizontal: the image plane never rolls, matching the shader.
      assertClose(basis.right[1], 0, 1e-6, `right horizontal (${i},${j})`);
    }
  }
});

test("blend weights are barycentric and peak on the exact grid view", () => {
  const n = 12;
  // Exactly on a grid point: that view carries (numerically) all the weight.
  const exact = gridViewDirection(3, 7, n);
  const atGrid = blendViews(exact, n);
  const total = atGrid.weights[0] + atGrid.weights[1] + atGrid.weights[2];
  assertClose(total, 1, 1e-6, "weights sum to 1 at a grid point");
  let peak = 0;
  for (let k = 0; k < 3; k += 1) {
    if (atGrid.weights[k] >= atGrid.weights[peak]) peak = k;
    assert.ok(atGrid.weights[k] >= -1e-6, "no negative weight");
  }
  assert.deepEqual(atGrid.tiles[peak], [3, 7]);
  assert.ok(atGrid.weights[peak] > 0.999, "grid view dominates on a grid point");

  // Off-grid directions: weights stay barycentric and tiles stay in range.
  for (let a = 0; a < 32; a += 1) {
    for (let e = 1; e < 8; e += 1) {
      const azimuth = (a / 32) * Math.PI * 2 + 0.13;
      const elevation = (e / 8) * (Math.PI / 2) * 0.97;
      const direction: [number, number, number] = [
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(azimuth) * Math.cos(elevation),
      ];
      const blend = blendViews(direction, n);
      const sum = blend.weights[0] + blend.weights[1] + blend.weights[2];
      assertClose(sum, 1, 1e-6, `weights sum az ${a} el ${e}`);
      for (const [ti, tj] of blend.tiles) {
        assert.ok(ti >= 0 && ti < n && tj >= 0 && tj < n, `tile in range az ${a} el ${e}`);
      }
    }
  }
});
