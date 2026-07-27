// CPU-side heightfield.
//
// This module is intentionally Three.js-agnostic. It is:
//   1. the elevation source for the terrain mesh builder (terrainGeometry.ts), and
//   2. the seed of the Phase 3 gameplay/concealment heightfield
//      (docs/04-concealment-system-design.md §1), which must be sampled
//      independently of whatever the GPU draws.
//
// For the scaffold the field is synthesized from fBm noise; when real assets
// arrive the same public interface (sample / normal) is backed by a decoded
// heightmap PNG instead, and nothing downstream changes.

import { fbm } from "./noise";
import {
  WORLD_SIZE,
  HALF_WORLD,
  GRID_CELLS,
  CELL_SIZE,
  TERRAIN_HEIGHT,
} from "./config";

// How many noise lattice units the world spans at the coarsest octave — controls
// the size of the largest landforms.
const BASE_FREQUENCY = 5;

// Shape a normalized [0,1] fBm value into an elevation. The power curve flattens
// lowlands (readable grass plains, apt for DF2) and keeps highlands sharper.
function shape(n: number): number {
  return Math.pow(n, 1.85) * TERRAIN_HEIGHT;
}

export type Vec3Out = [number, number, number];

export interface HeightfieldOptions {
  seed?: number;
}

export class Heightfield {
  readonly seed: number;
  readonly n: number; // cells per side; (n+1)² samples
  readonly stride: number;
  readonly grid: Float32Array;
  maxHeight = 0;

  constructor({ seed = 1337 }: HeightfieldOptions = {}) {
    this.seed = seed;
    this.n = GRID_CELLS;
    this.stride = this.n + 1;
    this.grid = new Float32Array(this.stride * this.stride);
    this.#build();
  }

  #build(): void {
    const { grid, stride, seed } = this;
    let max = 0;
    for (let j = 0; j <= this.n; j++) {
      const z = -HALF_WORLD + j * CELL_SIZE;
      const nz = ((z + HALF_WORLD) / WORLD_SIZE) * BASE_FREQUENCY;
      for (let i = 0; i <= this.n; i++) {
        const x = -HALF_WORLD + i * CELL_SIZE;
        const nx = ((x + HALF_WORLD) / WORLD_SIZE) * BASE_FREQUENCY;
        const h = shape(fbm(nx, nz, { seed, octaves: 6 }));
        grid[j * stride + i] = h;
        if (h > max) max = h;
      }
    }
    this.maxHeight = max;
  }

  // Bilinear elevation lookup at world (x, z). Coordinates outside the world are
  // clamped to the edge.
  sample(x: number, z: number): number {
    const { stride, grid, n } = this;
    let gx = (x + HALF_WORLD) / CELL_SIZE;
    let gz = (z + HALF_WORLD) / CELL_SIZE;
    if (gx < 0) gx = 0;
    else if (gx > n) gx = n;
    if (gz < 0) gz = 0;
    else if (gz > n) gz = n;

    const i0 = Math.floor(gx);
    const j0 = Math.floor(gz);
    const i1 = i0 < n ? i0 + 1 : i0;
    const j1 = j0 < n ? j0 + 1 : j0;
    const fx = gx - i0;
    const fz = gz - j0;

    const h00 = grid[j0 * stride + i0];
    const h10 = grid[j0 * stride + i1];
    const h01 = grid[j1 * stride + i0];
    const h11 = grid[j1 * stride + i1];

    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  // Analytic surface normal at world (x, z) via central differences.
  // Written into `out` to avoid per-call allocation. Using the field gradient
  // (not mesh triangles) keeps lighting stable across LOD levels
  // (docs/03-terrain-and-grass-rendering-design.md §2.4).
  normal(x: number, z: number, out: Vec3Out = [0, 1, 0]): Vec3Out {
    const e = CELL_SIZE;
    const hL = this.sample(x - e, z);
    const hR = this.sample(x + e, z);
    const hD = this.sample(x, z - e);
    const hU = this.sample(x, z + e);
    // normal = normalize(-dH/dx, 1, -dH/dz)
    const nx = -(hR - hL) / (2 * e);
    const nz = -(hU - hD) / (2 * e);
    const ny = 1;
    const inv = 1 / Math.hypot(nx, ny, nz);
    out[0] = nx * inv;
    out[1] = ny * inv;
    out[2] = nz * inv;
    return out;
  }
}
