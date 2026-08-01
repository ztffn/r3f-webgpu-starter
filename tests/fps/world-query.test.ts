import assert from "node:assert/strict";
import test from "node:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three/webgpu";
import {
  CompositeWorldQuery,
  HeightfieldWorldQuery,
  ThreeWorldQuery,
  type HeightfieldQuerySource,
} from "../../src/fps/core/WorldQuery.ts";

function heightfield(
  sample: (x: number, z: number) => number,
  normal: HeightfieldQuerySource["normal"] = (_x, _z, out = [0, 1, 0]) => {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return out;
  },
  minHeight = 0,
  maxHeight = 0
): HeightfieldQuerySource {
  return {
    cellSize: 1,
    halfWorld: 0,
    minHeight,
    maxHeight,
    sample,
    normal,
  };
}

test("analytic heightfield query hits terrain without render geometry", () => {
  const query = new HeightfieldWorldQuery(heightfield(() => 0));
  const hit = query.raycast(new Vector3(3, 10, -2), new Vector3(0, -1, 0), 20);
  assert.ok(hit);
  assert.equal(hit.kind, "terrain");
  assert.equal(hit.object.name, "terrain-heightfield-collider");
  assert.ok(Math.abs(hit.distance - 10) < 1e-8);
  assert.ok(Math.abs(hit.point.y) < 1e-8);

  const miss = query.raycast(new Vector3(0, 10, 0), new Vector3(1, 0, 0), 1_300);
  assert.equal(miss, null);
});

test("cell traversal catches a bilinear hill between positive endpoints", () => {
  const source = heightfield(
    (x, z) => x * z,
    (x, z, out = [0, 1, 0]) => {
      const inv = 1 / Math.hypot(z, 1, x);
      out[0] = -z * inv;
      out[1] = inv;
      out[2] = -x * inv;
      return out;
    },
    0,
    0.25
  );
  const query = new HeightfieldWorldQuery(source);
  const hit = query.raycast(
    new Vector3(0, 0.1, 1),
    new Vector3(1, 0, -1),
    Math.SQRT2
  );
  assert.ok(hit, "the ray crosses the interior peak even though both cell edges are lower");
  const expectedX = (1 - Math.sqrt(0.6)) * 0.5;
  assert.ok(Math.abs(hit.point.x - expectedX) < 1e-7);
  assert.ok(Math.abs(hit.point.z - (1 - expectedX)) < 1e-7);
});

test("analytic heightfield query resolves a sloped surface and its normal", () => {
  const query = new HeightfieldWorldQuery(
    heightfield(
      (x) => x * 0.25,
      (_x, _z, out = [0, 1, 0]) => {
        const inv = 1 / Math.hypot(0.25, 1);
        out[0] = -0.25 * inv;
        out[1] = inv;
        out[2] = 0;
        return out;
      },
      -10,
      10
    )
  );
  const hit = query.raycast(new Vector3(0, 1, 0), new Vector3(1, -0.5, 0), 10);
  assert.ok(hit);
  assert.ok(Math.abs(hit.point.x - 4 / 3) < 1e-7);
  assert.ok(Math.abs(hit.point.y - 1 / 3) < 1e-7);
  assert.ok(hit.normal && hit.normal.x < 0 && hit.normal.y > 0);
});

test("spatial collider index visits only roots in crossed cells", () => {
  const query = new ThreeWorldQuery(0, 32);
  const geometry = new BoxGeometry(2, 2, 2);
  const material = new MeshBasicMaterial();
  const unregister: Array<() => void> = [];
  for (let index = 0; index < 100; index += 1) {
    const root = new Mesh(geometry, material);
    root.name = `indexed-${index}`;
    root.position.set(index * 64 + 16, 0, 0);
    unregister.push(query.register({ root, kind: "world", objectId: root.name }));
  }

  const hit = query.raycast(new Vector3(16, 0, 10), new Vector3(0, 0, -1), 20);
  assert.equal(hit?.objectId, "indexed-0");
  assert.ok(query.getMetrics().colliderCandidates <= 2);

  for (const dispose of unregister) dispose();
  geometry.dispose();
  material.dispose();
});

test("composite query returns the nearer collider and forbids visual terrain roots", () => {
  const query = new CompositeWorldQuery(heightfield(() => 0));
  const geometry = new BoxGeometry(2, 2, 2);
  const material = new MeshBasicMaterial();
  const collider = new Mesh(geometry, material);
  collider.position.set(0, 5, 0);
  const unregister = query.register({
    root: collider,
    kind: "target",
    objectId: "near-target",
  });

  const hit = query.raycast(new Vector3(0, 10, 0), new Vector3(0, -1, 0), 20);
  assert.equal(hit?.objectId, "near-target");
  assert.throws(
    () => query.register({ root: new Group(), kind: "terrain" }),
    /Visual terrain registration is forbidden/
  );

  unregister();
  geometry.dispose();
  material.dispose();
});
