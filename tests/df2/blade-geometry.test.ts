// Shape invariants for the near-field grass blade primitive (src/df2/bladeGeometry.ts).
//
// Everything downstream of the blade keys off two things: the UV's vertical component,
// which anchors wind, the colour ramp and the eventual trail masks, and the width taper,
// which is what makes a blade read as a blade. Both are asserted here rather than judged
// on screen, where a wrong taper looks merely stylistic.

import assert from "node:assert/strict";
import test from "node:test";
import { bladeVertexData } from "../../src/df2/bladeGeometry.ts";

const SHAPE = { segments: 3, width: 0.05, height: 1, vDepth: 0.3 };

const vertexCount = (positions: Float32Array): number => positions.length / 3;
const at = (positions: Float32Array, i: number): [number, number, number] => [
  positions[i * 3],
  positions[i * 3 + 1],
  positions[i * 3 + 2],
];

test("blade is three vertices per ring plus a single apex", () => {
  const { positions, uvs, indices } = bladeVertexData(SHAPE);
  assert.equal(vertexCount(positions), SHAPE.segments * 3 + 1);
  assert.equal(uvs.length / 2, vertexCount(positions));
  // 4 triangles per full segment, 2 for the fan onto the apex.
  assert.equal(indices.length / 3, (SHAPE.segments - 1) * 4 + 2);
  for (const i of indices) assert.ok(i < vertexCount(positions), `index ${i} out of range`);
});

test("uv.y runs 0 at the root and 1 at the apex, ascending by ring", () => {
  const { positions, uvs } = bladeVertexData(SHAPE);
  assert.equal(uvs[1], 0);
  assert.equal(uvs[uvs.length - 1], 1);
  for (let s = 0; s < SHAPE.segments; s++) {
    // Tolerances throughout: the buffers are float32, the expectations float64.
    const v = uvs[s * 3 * 2 + 1];
    assert.ok(Math.abs(v - s / SHAPE.segments) < 1e-6, `ring ${s} v`);
    // Every vertex of a ring shares its v, and u spans the section.
    assert.deepEqual(
      [uvs[s * 3 * 2], uvs[(s * 3 + 1) * 2], uvs[(s * 3 + 2) * 2]],
      [0, 0.5, 1]
    );
  }
  // v is the blade's own height fraction, so it must track y exactly.
  const apex = vertexCount(positions) - 1;
  for (let i = 0; i <= apex; i++) assert.ok(Math.abs(at(positions, i)[1] - uvs[i * 2 + 1]) < 1e-6);
});

test("width tapers linearly to a point, and the V closes with it", () => {
  const { positions } = bladeVertexData(SHAPE);
  for (let s = 0; s < SHAPE.segments; s++) {
    const expected = SHAPE.width * (1 - s / SHAPE.segments);
    const left = at(positions, s * 3);
    const centre = at(positions, s * 3 + 1);
    const right = at(positions, s * 3 + 2);
    assert.ok(Math.abs(right[0] - left[0] - expected) < 1e-6, `ring ${s} width`);
    // The centre offset is a fraction of THIS ring's width, not of the root's, so a
    // blade narrows to a point instead of to a fold.
    assert.ok(Math.abs(centre[2] - expected * SHAPE.vDepth) < 1e-6, `ring ${s} depth`);
  }
  assert.deepEqual(at(positions, vertexCount(positions) - 1), [0, SHAPE.height, 0]);
});

test("no triangle is degenerate", () => {
  // The reason the apex is one vertex rather than a collapsed ring: the reference's
  // layout makes a third of a 3-segment blade's triangles zero-area.
  const { positions, indices } = bladeVertexData(SHAPE);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [at(positions, indices[t]), at(positions, indices[t + 1]), at(positions, indices[t + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const area = Math.hypot(cross[0], cross[1], cross[2]) / 2;
    assert.ok(area > 1e-9, `triangle ${t / 3} has zero area`);
  }
});

test("a one-segment blade is a bare triangle pair", () => {
  const { positions, indices } = bladeVertexData({ ...SHAPE, segments: 1 });
  assert.equal(vertexCount(positions), 4);
  assert.equal(indices.length / 3, 2);
});
