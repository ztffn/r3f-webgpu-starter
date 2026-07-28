// CPU-side heightfield.
//
// This module is intentionally Three.js-agnostic. It is:
//   1. the elevation source for the terrain mesh builder (terrainGeometry.ts), and
//   2. the seed of the Phase 3 gameplay/concealment heightfield
//      (docs/04-concealment-system-design.md §1), which must be sampled
//      independently of whatever the GPU draws.
//
// Two construction paths, one interface:
//   new Heightfield()                 — synthetic fBm (no assets needed)
//   Heightfield.fromHeightmap(...)    — a real extracted DF heightmap
//
// The instance carries its own world extent, so the rest of the renderer works
// unchanged whether the map is a 1 km synthetic field or a ~2 km real one.

import { fbm } from "./noise";
import {
  WORLD_SIZE,
  GRID_CELLS,
  TERRAIN_HEIGHT,
  METERS_PER_TEXEL,
  HEIGHT_SCALE,
} from "./config";

// How many noise lattice units the synthetic world spans at the coarsest octave.
const BASE_FREQUENCY = 5;

export type Vec3Out = [number, number, number];

export interface HeightmapSource {
  /** Raw 8-bit elevation samples, row-major, `size` x `size`. Row 0 = north edge. */
  data: Uint8Array;
  size: number;
  metersPerTexel?: number;
  heightScale?: number;
}

export class Heightfield {
  /** Cells per side; the sample grid is (n+1) x (n+1). */
  readonly n: number;
  readonly stride: number;
  /** Metres between adjacent samples. */
  readonly cellSize: number;
  /** Total world extent in metres (n * cellSize). */
  readonly worldSize: number;
  readonly halfWorld: number;
  readonly grid: Float32Array;
  minHeight = 0;
  maxHeight = 0;
  /** True when built from real extracted terrain data rather than noise. */
  readonly isReal: boolean;

  private constructor(n: number, cellSize: number, grid: Float32Array, isReal: boolean) {
    this.n = n;
    this.stride = n + 1;
    this.cellSize = cellSize;
    this.worldSize = n * cellSize;
    this.halfWorld = this.worldSize / 2;
    this.grid = grid;
    this.isReal = isReal;

    let min = Infinity;
    let max = -Infinity;
    for (const h of grid) {
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.minHeight = min;
    this.maxHeight = max;
  }

  /** Synthetic fBm terrain — the no-assets fallback. */
  static synthetic(seed = 1337): Heightfield {
    const n = GRID_CELLS;
    const stride = n + 1;
    const cellSize = WORLD_SIZE / n;
    const half = WORLD_SIZE / 2;
    const grid = new Float32Array(stride * stride);
    for (let j = 0; j <= n; j++) {
      const z = -half + j * cellSize;
      const nz = ((z + half) / WORLD_SIZE) * BASE_FREQUENCY;
      for (let i = 0; i <= n; i++) {
        const x = -half + i * cellSize;
        const nx = ((x + half) / WORLD_SIZE) * BASE_FREQUENCY;
        // Power curve flattens lowlands and keeps highlands sharper.
        grid[j * stride + i] = Math.pow(fbm(nx, nz, { seed, octaves: 6 }), 1.85) * TERRAIN_HEIGHT;
      }
    }
    return new Heightfield(n, cellSize, grid, false);
  }

  /** Build from a real extracted DF heightmap (8-bit greyscale, size x size). */
  static fromHeightmap(src: HeightmapSource): Heightfield {
    const { data, size } = src;
    const cellSize = src.metersPerTexel ?? METERS_PER_TEXEL;
    const scale = src.heightScale ?? HEIGHT_SCALE;
    // `size` samples per side => size-1 cells.
    const n = size - 1;
    const grid = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) grid[i] = data[i] * scale;
    return new Heightfield(n, cellSize, grid, true);
  }

  /** Bilinear elevation at world (x, z). Outside the map, clamps to the edge. */
  sample(x: number, z: number): number {
    const { stride, grid, n, cellSize, halfWorld } = this;
    let gx = (x + halfWorld) / cellSize;
    let gz = (z + halfWorld) / cellSize;
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

  /**
   * Analytic surface normal at world (x, z) via central differences, written
   * into `out` to avoid per-call allocation. Using the field gradient (not mesh
   * triangles) keeps lighting stable across LOD levels
   * (docs/03-terrain-and-grass-rendering-design.md §2.4).
   */
  normal(x: number, z: number, out: Vec3Out = [0, 1, 0]): Vec3Out {
    const e = this.cellSize;
    const hL = this.sample(x - e, z);
    const hR = this.sample(x + e, z);
    const hD = this.sample(x, z - e);
    const hU = this.sample(x, z + e);
    const nx = -(hR - hL) / (2 * e);
    const nz = -(hU - hD) / (2 * e);
    const inv = 1 / Math.hypot(nx, 1, nz);
    out[0] = nx * inv;
    out[1] = inv;
    out[2] = nz * inv;
    return out;
  }
}
