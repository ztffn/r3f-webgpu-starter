// Builds a single terrain chunk's BufferGeometry from a Heightfield.
//
// Each chunk is a regular grid at a given LOD (segment count) plus a perimeter
// "skirt" — a ring of edge vertices dropped straight down — to hide the cracks
// that appear where neighbouring chunks are at different LODs
// (docs/03-terrain-and-grass-rendering-design.md §2.3).
//
// Normals come from the heightfield gradient, not the triangles, so shading is
// identical across LODs (§2.4).

import * as THREE from "three/webgpu";
import { WORLD_SIZE, HALF_WORLD, SKIRT_DEPTH } from "./config";
import type { Heightfield, Vec3Out } from "./Heightfield";

// Global UV so a (future) colormap texture tiles continuously across chunk seams.
function worldToUv(x: number, z: number): [number, number] {
  return [(x + HALF_WORLD) / WORLD_SIZE, (z + HALF_WORLD) / WORLD_SIZE];
}

export interface ChunkGeometryParams {
  heightfield: Heightfield;
  ox: number;
  oz: number;
  size: number;
  segments: number;
}

export function buildChunkGeometry({
  heightfield,
  ox,
  oz,
  size,
  segments,
}: ChunkGeometryParams): THREE.BufferGeometry {
  const N = segments;
  const rowStride = N + 1;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const nrm: Vec3Out = [0, 1, 0];

  // --- Grid vertices -------------------------------------------------------
  for (let j = 0; j <= N; j++) {
    const z = oz + (j / N) * size;
    for (let i = 0; i <= N; i++) {
      const x = ox + (i / N) * size;
      const y = heightfield.sample(x, z);
      heightfield.normal(x, z, nrm);
      const [u, v] = worldToUv(x, z);
      positions.push(x, y, z);
      normals.push(nrm[0], nrm[1], nrm[2]);
      uvs.push(u, v);
    }
  }

  const gridIndex = (i: number, j: number) => j * rowStride + i;

  // --- Grid faces ----------------------------------------------------------
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = gridIndex(i, j);
      const b = gridIndex(i + 1, j);
      const c = gridIndex(i, j + 1);
      const d = gridIndex(i + 1, j + 1);
      indices.push(a, c, b, b, c, d);
    }
  }

  // --- Skirts --------------------------------------------------------------
  // Duplicate an edge vertex lowered by SKIRT_DEPTH; material is double-sided so
  // skirt winding does not matter.
  const pushLowered = (g: number): number => {
    const p = g * 3;
    positions.push(positions[p], positions[p + 1] - SKIRT_DEPTH, positions[p + 2]);
    normals.push(normals[p], normals[p + 1], normals[p + 2]);
    uvs.push(uvs[g * 2], uvs[g * 2 + 1]);
    return positions.length / 3 - 1;
  };

  const addSkirtEdge = (edgeVerts: number[]): void => {
    for (let k = 0; k < edgeVerts.length - 1; k++) {
      const g0 = edgeVerts[k];
      const g1 = edgeVerts[k + 1];
      const l0 = pushLowered(g0);
      const l1 = pushLowered(g1);
      indices.push(g0, g1, l1, g0, l1, l0);
    }
  };

  const topEdge: number[] = [];
  const bottomEdge: number[] = [];
  const leftEdge: number[] = [];
  const rightEdge: number[] = [];
  for (let i = 0; i <= N; i++) {
    topEdge.push(gridIndex(i, 0));
    bottomEdge.push(gridIndex(i, N));
  }
  for (let j = 0; j <= N; j++) {
    leftEdge.push(gridIndex(0, j));
    rightEdge.push(gridIndex(N, j));
  }
  addSkirtEdge(topEdge);
  addSkirtEdge(bottomEdge);
  addSkirtEdge(leftEdge);
  addSkirtEdge(rightEdge);

  // --- Assemble ------------------------------------------------------------
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
