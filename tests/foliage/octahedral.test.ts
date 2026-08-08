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

/**
 * Below the horizon the encoder must CLAMP, not reflect.
 *
 * Unpinned until now: the sweep above starts at elevation 0 and goes up, so the encoder
 * could do anything at all with a negative y and no test would notice. It did — it used
 * `abs(y)` where `FarFoliageMaterial`'s TSL mirror uses `max(y, 0)`, which reflects a
 * below-horizon view onto an elevated tile instead of onto the horizon ring. Only the
 * shader runs at runtime so nothing rendered wrong, but this module exists to be the one
 * definition that cannot drift, and these are the assertions that keep it honest.
 */
test("below-horizon directions clamp onto the horizon ring, not onto a reflected view", () => {
  for (let a = 0; a < 32; a += 1) {
    for (let e = 1; e <= 8; e += 1) {
      const azimuth = (a / 32) * Math.PI * 2;
      const elevation = -(e / 8) * (Math.PI / 2) * 0.99;
      const x = Math.cos(azimuth) * Math.cos(elevation);
      const y = Math.sin(elevation);
      const z = Math.sin(azimuth) * Math.cos(elevation);
      const [u, v] = hemiOctEncode(x, y, z);

      assert.ok(u >= -1.0001 && u <= 1.0001, `u in range az ${a} el ${e}`);
      assert.ok(v >= -1.0001 && v <= 1.0001, `v in range az ${a} el ${e}`);

      // On the boundary: for a horizon direction |px| + |pz| = 1, and u = px + pz,
      // v = pz - px, so exactly one of |u|, |v| reaches 1.
      assertClose(Math.max(Math.abs(u), Math.abs(v)), 1, 1e-6, `on the ring az ${a} el ${e}`);

      // Same tile as this direction's own horizon projection — that is what "clamped onto
      // the horizon" means, and it is the property `abs(y)` silently broke.
      const flat = Math.hypot(x, z);
      const [hu, hv] = hemiOctEncode(x / flat, 0, z / flat);
      assertClose(u, hu, 1e-6, `u matches horizon projection az ${a} el ${e}`);
      assertClose(v, hv, 1e-6, `v matches horizon projection az ${a} el ${e}`);

      // And NOT the mirrored direction's tile, which is what reflection would have given.
      const [mu, mv] = hemiOctEncode(x, -y, z);
      assert.ok(
        Math.hypot(u - mu, v - mv) > 1e-3,
        `az ${a} el ${e} encodes the same as its mirror — the encoder is reflecting`
      );
    }
  }
});

test("the encoder agrees with the shader's fold for a direction either side of the horizon", () => {
  // The TSL mirror in FarFoliageMaterial: denom = |x| + max(y,0) + |z|, fold to
  // (px+pz, pz-px), then clamp. Transcribed here so a change to either side has to be
  // made in both, which is the only enforcement a shader/JS pair can have.
  const shaderFold = (x: number, y: number, z: number): [number, number] => {
    const denom = Math.max(Math.abs(x) + Math.max(y, 0) + Math.abs(z), 1e-5);
    const px = x / denom;
    const pz = z / denom;
    const clamp = (n: number) => Math.min(1, Math.max(-1, n));
    return [clamp(px + pz), clamp(pz - px)];
  };
  for (let a = 0; a < 16; a += 1) {
    for (let e = -6; e <= 6; e += 1) {
      const azimuth = (a / 16) * Math.PI * 2;
      const elevation = (e / 6) * (Math.PI / 2) * 0.99;
      const x = Math.cos(azimuth) * Math.cos(elevation);
      const y = Math.sin(elevation);
      const z = Math.sin(azimuth) * Math.cos(elevation);
      const [u, v] = hemiOctEncode(x, y, z);
      const [su, sv] = shaderFold(x, y, z);
      assertClose(u, su, 1e-6, `u matches the shader az ${a} el ${e}`);
      assertClose(v, sv, 1e-6, `v matches the shader az ${a} el ${e}`);
    }
  }
});
