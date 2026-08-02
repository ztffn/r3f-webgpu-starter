// The near-field grass blade primitive — one tapered blade, built once and instanced.
//
// A stack of three-vertex rings converging on a single apex: left and right edges in
// the blade's local XY plane, the centre vertex pushed along local +Z so the section
// reads as a shallow V rather than a flat ribbon. Everything downstream keys off the
// UV's vertical component, which runs 0 at the root to 1 at the tip.

import * as THREE from "three/webgpu";

export interface BladeShape {
  /** Rings minus one. 3 gives 4 rings, 10 vertices, 10 triangles. */
  segments: number;
  /** Full width at the root, in the blade's own units. Tapers linearly to the apex. */
  width: number;
  /**
   * Centre-vertex offset along local +Z, as a fraction of that ring's OWN width.
   *
   * A fraction of the ring rather than of the root, so the V closes as the blade
   * narrows and the tip is a point rather than a fold. The reference implementation
   * uses 0.5 — a 45 degree V that reads as a rounded modern blade; DF2's identity is
   * flatter than that (docs/03 §4.4).
   */
  vDepth: number;
}

export interface BladeVertexData {
  /** xyz triples: 3 per ring for `segments` rings, then one apex vertex. */
  positions: Float32Array;
  /** uv pairs. u is 0 / 0.5 / 1 across the section, v is 0 at the root, 1 at the tip. */
  uvs: Float32Array;
  indices: Uint16Array;
}

/**
 * Vertex data for one blade, with no Three.js dependency so the shape can be
 * asserted directly rather than through a renderer.
 *
 * THE APEX IS ONE VERTEX, not a third collapsed ring. The reference emits
 * `segments + 1` full rings, which makes the tip ring three coincident points and
 * every triangle touching it degenerate — a third of the primitives on a 3-segment
 * blade. They shade nothing, but they are still assembled and clipped, and at a few
 * thousand instances that is a third of the primitive setup for no picture.
 */
export function bladeVertexData({ segments, width, vDepth }: BladeShape): BladeVertexData {
  const rings = Math.max(1, Math.floor(segments));
  const positions = new Float32Array((rings * 3 + 1) * 3);
  const uvs = new Float32Array((rings * 3 + 1) * 2);
  // 4 triangles per full segment, and 2 for the fan onto the apex.
  const indices = new Uint16Array(((rings - 1) * 4 + 2) * 3);

  let p = 0;
  let t = 0;
  for (let s = 0; s < rings; s++) {
    const v = s / rings;
    const w = width * (1 - v);
    // UNIT HEIGHT, always: the renderer scales each blade to the canopy height the
    // march would give that spot (grassField.columnTop), so a height here would only
    // fight it. That also makes uv.v and y the same number, which every later stage
    // relies on — wind anchoring, the colour ramp, and the eventual trail masks.
    const y = v;
    const z = w * vDepth;
    // left, centre, right — the order every index below assumes.
    positions[p * 3] = -w * 0.5;
    positions[p * 3 + 1] = y;
    positions[p * 3 + 2] = 0;
    uvs[p * 2] = 0;
    uvs[p * 2 + 1] = v;
    p++;
    positions[p * 3] = 0;
    positions[p * 3 + 1] = y;
    positions[p * 3 + 2] = z;
    uvs[p * 2] = 0.5;
    uvs[p * 2 + 1] = v;
    p++;
    positions[p * 3] = w * 0.5;
    positions[p * 3 + 1] = y;
    positions[p * 3 + 2] = 0;
    uvs[p * 2] = 1;
    uvs[p * 2 + 1] = v;
    p++;
  }
  const apex = rings * 3;
  positions[apex * 3] = 0;
  positions[apex * 3 + 1] = 1;
  positions[apex * 3 + 2] = 0;
  uvs[apex * 2] = 0.5;
  uvs[apex * 2 + 1] = 1;

  const tri = (a: number, b: number, c: number): void => {
    indices[t++] = a;
    indices[t++] = b;
    indices[t++] = c;
  };
  for (let s = 0; s < rings - 1; s++) {
    const lo = s * 3;
    const hi = (s + 1) * 3;
    // Left half, then right half. Both wind the same way so a single-sided material
    // would at least be consistent — though the renderer draws these double-sided,
    // since a world-anchored blade culled from behind does not save fill, it vanishes.
    tri(lo, hi, lo + 1);
    tri(hi, hi + 1, lo + 1);
    tri(lo + 1, hi + 1, lo + 2);
    tri(hi + 1, hi + 2, lo + 2);
  }
  const last = (rings - 1) * 3;
  tri(last, apex, last + 1);
  tri(last + 1, apex, last + 2);

  return { positions, uvs, indices };
}

/**
 * The same blade as an instanced geometry, ready to draw.
 *
 * NO NORMALS. The material is unlit, following every other material in this renderer,
 * because the colormap is pre-shaded (docs/03 §4.4) — so `computeVertexNormals`, which
 * the reference calls here, would build an attribute nothing reads.
 *
 * INSTANCED BUFFER GEOMETRY rather than an InstancedMesh, because every blade derives
 * its world position from `cameraPosition` in the vertex stage and so needs no per-
 * instance matrix at all. An InstancedMesh would allocate 16 floats per instance —
 * 1.9 MB at the shipped count — upload them, and then multiply every vertex by the
 * identity, since three injects the instance matrix into `positionLocal` before the
 * material's own `positionNode` runs.
 */
export function buildBladeGeometry(
  shape: BladeShape,
  instanceCount: number
): THREE.InstancedBufferGeometry {
  const { positions, uvs, indices } = bladeVertexData(shape);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.instanceCount = instanceCount;
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}
