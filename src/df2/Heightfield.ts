// CPU-side heightfield.
//
// This module is intentionally Three.js-agnostic. It is:
//   1. the elevation source for the terrain mesh builder (terrainGeometry.ts), and
//   2. the seed of the Phase 3 gameplay/concealment heightfield
//      (docs/04-concealment-system-design.md §1), which must be sampled
//      independently of whatever the GPU draws.
//
// THE MAP TILES INFINITELY. DF2 terrain has no edges — it repeats forever in x
// and z (docs/06-asset-extraction-findings.md §10). So the field stores exactly
// `period x period` distinct samples and every lookup wraps modulo that period;
// there is no duplicated edge row and no clamping.
//
// Two construction paths, one interface — and the synthetic one now goes THROUGH
// the real one:
//   Heightfield.syntheticBytes()      — periodic fBm, quantised to 8 bits
//   Heightfield.synthetic()           — the above, fed to fromHeightmap
//   Heightfield.fromHeightmap(...)    — a real extracted DF heightmap
//
// Quantising the synthetic field to 8 bits is not cosmetic. The grass shader reads
// elevation from a TEXTURE while the mesh and the concealment query read this
// field, and they must agree exactly or grass floats above or sinks into the
// ground. A real map gets that for free because both sides come from the same
// bytes; the synthetic path only gets it by being quantised the same way.

import { fbm } from "./noise";
import {
  WORLD_SIZE,
  GRID_CELLS,
  TERRAIN_HEIGHT,
  METERS_PER_TEXEL,
  HEIGHT_SCALE,
  HEIGHT_SMOOTH_PASSES,
} from "./config";

// Lattice units the synthetic tile spans at the base octave. Integer, so the
// noise wraps cleanly and the tile is seamless.
const BASE_FREQUENCY = 5;

export type Vec3Out = [number, number, number];

export interface HeightmapSource {
  /** Raw 8-bit elevation samples, row-major, `size` x `size`. Row 0 = north edge. */
  data: Uint8Array;
  size: number;
  metersPerTexel?: number;
  heightScale?: number;
  /** Overrides HEIGHT_SMOOTH_PASSES. 0 keeps the raw quantised surface. */
  smoothPasses?: number;
}

/**
 * Reconstruct sub-unit relief that 8-bit storage quantised away.
 *
 * The source heightmap has 256 levels, so the smallest representable change is one raw
 * unit — 1 m at HEIGHT_SCALE 1.0, across a 2 m texel, which is a **26.6 degree facet**.
 * Measured on Green Mile: the MEDIAN facet angle is exactly that 26.6 degrees, and 48% of
 * adjacent samples are identical. The surface is step-flat-step-flat, and that terracing
 * is what reads as jagged and noisy. It is a storage artifact, not authored relief.
 *
 * DF2 itself never showed it: Voxel Space drew one column per screen column straight from
 * the samples and never built triangles out of the steps, so quantisation appeared as
 * vertical banding rather than as angular facets. Reconstructing here is what buys back
 * the soft rolling look, and doing it as a filter over the field is closer to the original
 * than raising the mesh resolution would be — more triangles only interpolate the terraces
 * more precisely.
 *
 * A separable binomial [1,2,1] kernel, wrapped (the map tiles). Each pass halves relief at
 * the 2-texel scale where the terracing lives while leaving the tens-of-metres features
 * that carry the terrain's shape essentially untouched.
 *
 * MUST run before anything reads the field. The renderer's ground, the grass march and the
 * concealment query all derive from this one grid, and docs/08 §8 invariant 3 requires
 * they agree — smoothing one consumer and not the others would float the grass off the
 * ground and desync what you see from what the game thinks you can see.
 */
function smoothTerracing(grid: Float32Array, size: number, passes: number): void {
  if (passes <= 0) return;
  const tmp = new Float32Array(grid.length);
  const wrap = (v: number) => (v < 0 ? v + size : v >= size ? v - size : v);
  for (let p = 0; p < passes; p++) {
    for (let z = 0; z < size; z++) {
      const row = z * size;
      for (let x = 0; x < size; x++) {
        tmp[row + x] =
          (grid[row + wrap(x - 1)] + 2 * grid[row + x] + grid[row + wrap(x + 1)]) * 0.25;
      }
    }
    for (let z = 0; z < size; z++) {
      const up = wrap(z - 1) * size;
      const dn = wrap(z + 1) * size;
      const row = z * size;
      for (let x = 0; x < size; x++) {
        grid[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[dn + x]) * 0.25;
      }
    }
  }
}

export class Heightfield {
  /** Samples per side. Also the tiling period — index i wraps to i % period. */
  readonly period: number;
  /** Metres between adjacent samples. */
  readonly cellSize: number;
  /** Size of one tile in metres (period * cellSize). The world repeats this. */
  readonly worldSize: number;
  readonly halfWorld: number;
  readonly grid: Float32Array;
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Metres per raw 8-bit unit of the source data this field was built from. */
  readonly heightScale: number;

  private constructor(
    period: number,
    cellSize: number,
    grid: Float32Array,
    heightScale: number
  ) {
    this.period = period;
    this.cellSize = cellSize;
    this.worldSize = period * cellSize;
    this.halfWorld = this.worldSize / 2;
    this.grid = grid;
    this.heightScale = heightScale;

    let min = Infinity;
    let max = -Infinity;
    for (const h of grid) {
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.minHeight = min;
    this.maxHeight = max;
  }

  /**
   * Synthetic, seamlessly tiling fBm elevation, quantised to 8 bits so it has the
   * same shape as an extracted heightmap. See the header for why quantising here
   * rather than downstream is what keeps the mesh and the grass shader in step.
   */
  static syntheticBytes(seed = 1337): Required<HeightmapSource> {
    const size = GRID_CELLS;
    const data = new Uint8Array(size * size);
    for (let j = 0; j < size; j++) {
      const nz = (j / size) * BASE_FREQUENCY;
      for (let i = 0; i < size; i++) {
        const nx = (i / size) * BASE_FREQUENCY;
        // Power curve flattens lowlands and keeps highlands sharper.
        const v = fbm(nx, nz, { seed, octaves: 6, period: BASE_FREQUENCY });
        data[j * size + i] = Math.round(Math.min(1, Math.pow(v, 1.85)) * 255);
      }
    }
    return {
      data,
      size,
      metersPerTexel: WORLD_SIZE / size,
      heightScale: TERRAIN_HEIGHT / 255,
      // The synthetic field is continuous fBm quantised to bytes on the way out, so it
      // terraces for the same reason the extracted map does.
      smoothPasses: HEIGHT_SMOOTH_PASSES,
    };
  }

  /** Synthetic, seamlessly tiling fBm terrain — the no-assets fallback. */
  static synthetic(seed = 1337): Heightfield {
    return Heightfield.fromHeightmap(Heightfield.syntheticBytes(seed));
  }

  /**
   * Build from a real extracted DF heightmap (8-bit greyscale, size x size).
   *
   * The raw grid is TERRACED and has to be reconstructed — see `smoothTerracing`.
   */
  static fromHeightmap(src: HeightmapSource): Heightfield {
    const { data, size } = src;
    const cellSize = src.metersPerTexel ?? METERS_PER_TEXEL;
    const scale = src.heightScale ?? HEIGHT_SCALE;
    if (data.length < size * size) {
      throw new Error(`heightmap has ${data.length} samples, expected ${size * size}`);
    }
    const grid = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) grid[i] = data[i] * scale;
    smoothTerracing(grid, size, src.smoothPasses ?? HEIGHT_SMOOTH_PASSES);
    return new Heightfield(size, cellSize, grid, scale);
  }

  /** Bilinear elevation at world (x, z). Wraps — the map has no edges. */
  sample(x: number, z: number): number {
    const { grid, period, cellSize, halfWorld } = this;
    const gx = (x + halfWorld) / cellSize;
    const gz = (z + halfWorld) / cellSize;

    const fx0 = Math.floor(gx);
    const fz0 = Math.floor(gz);
    const i0 = ((fx0 % period) + period) % period;
    const j0 = ((fz0 % period) + period) % period;
    const i1 = i0 + 1 === period ? 0 : i0 + 1;
    const j1 = j0 + 1 === period ? 0 : j0 + 1;
    const fx = gx - fx0;
    const fz = gz - fz0;

    const r0 = j0 * period;
    const r1 = j1 * period;
    const a = grid[r0 + i0] + (grid[r0 + i1] - grid[r0 + i0]) * fx;
    const b = grid[r1 + i0] + (grid[r1 + i1] - grid[r1 + i0]) * fx;
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
