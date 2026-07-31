// Builds a single terrain chunk's BufferGeometry from a Heightfield.
//
// Vertices are emitted in LOCAL space (0..size on x/z) with the world origin
// supplied separately, so one geometry can be reused at every tile repeat of the
// same chunk — the map tiles infinitely, so chunk (cx, cz) and chunk
// (cx + period, cz) have identical shape (docs/06 §10).
//
// UVs are the *wrapped* world position over one tile; the colormap uses
// RepeatWrapping, so the same UVs are correct at every repeat.
//
// Each chunk carries a perimeter "skirt" — a ring of edge vertices dropped
// straight down — to hide cracks where neighbouring chunks sit at different LODs
// (docs/03-terrain-and-grass-rendering-design.md §2.3).
//
// Normals come from the heightfield gradient, not the triangles, so shading is
// identical across LODs (§2.4).

import * as THREE from "three/webgpu";
import { SKIRT_DEPTH } from "./config";
import type { Heightfield, Vec3Out } from "./Heightfield";

export interface ChunkGeometryParams {
  heightfield: Heightfield;
  /** World-space corner of the chunk used for sampling (may be any tile repeat). */
  ox: number;
  oz: number;
  size: number;
  segments: number;
  /**
   * Emit the perimeter skirt. True for terrain, false for the grass shell.
   *
   * The grass shell reuses this geometry, and a skirt on it is meaningless: the
   * skirt is a vertical wall dropped below the surface to plug LOD cracks, so
   * marching a canopy from it paints grass down the inside of a 12 m cliff.
   */
  skirt?: boolean;
}

export function buildChunkGeometry({
  heightfield,
  ox,
  oz,
  size,
  segments,
  skirt = true,
}: ChunkGeometryParams): THREE.BufferGeometry {
  const N = segments;
  const rowStride = N + 1;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const nrm: Vec3Out = [0, 1, 0];
  // Vertical extent, tracked here so the bounding box costs nothing — see Assemble.
  let minY = Infinity;
  let maxY = -Infinity;
  const { halfWorld, worldSize } = heightfield;

  // --- Grid vertices (local space) -----------------------------------------
  for (let j = 0; j <= N; j++) {
    const lz = (j / N) * size;
    const wz = oz + lz;
    for (let i = 0; i <= N; i++) {
      const lx = (i / N) * size;
      const wx = ox + lx;
      // sample()/normal() wrap, so world coords outside the base tile are fine.
      const y = heightfield.sample(wx, wz);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      positions.push(lx, y, lz);
      heightfield.normal(wx, wz, nrm);
      normals.push(nrm[0], nrm[1], nrm[2]);
      uvs.push((wx + halfWorld) / worldSize, (wz + halfWorld) / worldSize);
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

  if (skirt) {
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
  }

  // --- Assemble ------------------------------------------------------------
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  // The box is load-bearing beyond culling: Terrain.tsx compares this chunk's maximum
  // elevation against the eye to decide whether the grass volume needs its floor proxy.
  // Set directly from the extent tracked in the vertex loop rather than by
  // computeBoundingBox(), which would be a third full pass over positions inside the
  // per-frame build budget. y is absolute; chunks are offset in x/z only.
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, skirt ? minY - SKIRT_DEPTH : minY, 0),
    new THREE.Vector3(size, maxY, size)
  );
  return geometry;
}
