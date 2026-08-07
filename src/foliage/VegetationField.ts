// Deterministic vegetation placement — the authoritative record of what grows where.
//
// Imports nothing from Three.js, for the same reason `Heightfield.ts` does not
// (docs/08 §3): this is the seed of a gameplay field. A bush that provides cover has to
// exist for a server with no renderer, and it has to exist identically for every client.
//
// DETERMINISM CONTRACT
// A cell's contents are a pure function of (mapSeed, rulesVersion, WRAPPED cell index)
// and the terrain heightfield. No Math.random, no time, no camera. Two consequences the
// rest of the system depends on:
//
//   1. It tiles with the terrain. DF2 terrain repeats every `worldSize` metres and the
//      chunk geometry cache is keyed on the WRAPPED chunk index (docs/08 §6.2). Keying
//      placement on the wrapped cell index too means the bush on the hill you can see is
//      the same bush on the same hill in the repeat behind it — and, less obviously, that
//      vegetation agrees with the shadows already baked into the colormap (docs/06 §6),
//      which repeat for exactly the same reason.
//
//   2. It is replication-ready without being replication. The research memo's
//      "map seed + cell coordinate + rule version + sparse state deltas" scheme needs
//      exactly this function and nothing else. Multiplayer is deliberately on hold
//      (docs/08 §13) — this does not start it, it just declines to foreclose it.
//
// Placement is STRATIFIED, not uniform-random: the cell is split into a lattice and each
// subcell contributes at most one candidate. Uniform random over a cell clumps, and
// clumped cover reads as unfair rather than as natural.

import { FOLIAGE_CELL, FOLIAGE_DENSITY, FOLIAGE_SITE_SPACING } from "./foliageConfig.ts";
import { SPECIES } from "./species.ts";
import { hash3i, rng32 } from "./vegetationHash.ts";

/** The slice of the terrain this module needs. `Heightfield` satisfies it structurally. */
export interface VegetationTerrain {
  sample(x: number, z: number): number;
  normal(x: number, z: number, out?: [number, number, number]): [number, number, number];
  /** Metres spanned by one tile; placement repeats over this. */
  readonly worldSize: number;
  readonly halfWorld: number;
}

export interface VegetationFieldOptions {
  terrain: VegetationTerrain;
  /** Requested cell side, metres. Snapped so a whole number of cells spans one tile. */
  cellSize?: number;
  /** Metres between candidate sites. Independent of cell size, deliberately. */
  siteSpacing?: number;
  density?: number;
  /** Per-map placement salt. Changing it reshuffles every plant on the map. */
  mapSeed?: number;
  /**
   * Bumped whenever the placement RULES change in a way that must invalidate previously
   * agreed placement. Part of the determinism key by design: two builds with different
   * rules must not silently believe they agree.
   */
  rulesVersion?: number;
  /** World height of the water plane; nothing grows below it plus a clearance. */
  waterHeight?: number;
}

/**
 * One cell's plants, in structure-of-arrays form, sorted by species.
 *
 * Positions are LOCAL to the cell origin so a cell record is valid at every tile repeat,
 * exactly like a cached chunk geometry. `speciesRanges` gives each species a contiguous
 * slice, which is what lets the renderer fill one instance buffer per (cell, species)
 * with a straight copy and no per-instance branching.
 */
export interface VegetationCell {
  readonly count: number;
  readonly offsetX: Float32Array;
  readonly offsetZ: Float32Array;
  /** Ground height at the plant's base, world metres (absolute, not cell-local). */
  readonly baseY: Float32Array;
  readonly rotationY: Float32Array;
  readonly scale: Float32Array;
  readonly seed: Uint32Array;
  /** [start, count] per species table index. */
  readonly speciesRanges: ReadonlyArray<readonly [number, number]>;
  /** Bounds for the cell's render bucket, in cell-local space. */
  readonly maxRadius: number;
  readonly minY: number;
  readonly maxY: number;
}

const EMPTY_RANGES = SPECIES.map(() => [0, 0] as const);

/** Lattice divisions per tile for the macro density field. Integer, so it tiles. */
const MACRO_LATTICE = 16;
const SALT_MACRO = 0x4d41;
const SALT_CELL = 0x43454c;

export class VegetationField {
  readonly cellSize: number;
  readonly cellsPerTile: number;
  /**
   * Global density multiplier. MUTABLE, unlike everything else here, so a dev slider can
   * move it without rebuilding the renderer's 500-odd bucket meshes — `setDensity` clears
   * the cell cache and bumps `version`, and the renderer's existing budgeted refill does
   * the rest.
   *
   * It is NOT on the networked visual-dial wire, deliberately. Cover is gameplay: a client
   * that grew itself twice the bushes would see cover the server never placed. Offline it
   * is an instrument; the moment vegetation becomes authoritative this has to come from the
   * room like weather does.
   */
  density: number;
  /** Bumped whenever cached placement is invalidated, so a renderer can notice. */
  version = 0;
  readonly mapSeed: number;
  readonly rulesVersion: number;
  readonly waterHeight: number;

  /**
   * Placement lattice per cell side, DERIVED from the cell size and the site spacing so
   * that plants per square metre does not move when the cell size does. Public because it
   * is also the hard upper bound on how many plants of one species a cell can hold, which
   * is what the renderer sizes its fixed instance buffers from — a bound that has to come
   * from here rather than be guessed there.
   */
  readonly placementGrid: number;
  readonly siteSpacing: number;

  private readonly terrain: VegetationTerrain;
  private readonly cache = new Map<number, VegetationCell>();
  private readonly normalScratch: [number, number, number] = [0, 1, 0];

  constructor(options: VegetationFieldOptions) {
    const requested = options.cellSize ?? FOLIAGE_CELL;
    const worldSize = options.terrain.worldSize;
    // Snap so a whole number of cells spans one tile. A fractional count would make the
    // wrapped index meaningless and the placement would visibly seam at the tile repeat.
    this.cellsPerTile = Math.max(1, Math.round(worldSize / requested));
    this.cellSize = worldSize / this.cellsPerTile;
    this.terrain = options.terrain;
    this.siteSpacing = options.siteSpacing ?? FOLIAGE_SITE_SPACING;
    this.placementGrid = Math.max(1, Math.round(this.cellSize / this.siteSpacing));
    this.density = options.density ?? FOLIAGE_DENSITY;
    this.mapSeed = (options.mapSeed ?? 0) >>> 0;
    this.rulesVersion = options.rulesVersion ?? 1;
    this.waterHeight = options.waterHeight ?? -Infinity;
  }

  /** Absolute (unbounded, possibly negative) cell index containing a world X or Z. */
  cellIndexAt(coordinate: number): number {
    return Math.floor((coordinate + this.terrain.halfWorld) / this.cellSize);
  }

  /** World coordinate of a cell's minimum corner along one axis. */
  cellOrigin(index: number): number {
    return index * this.cellSize - this.terrain.halfWorld;
  }

  wrap(index: number): number {
    const n = this.cellsPerTile;
    return ((index % n) + n) % n;
  }

  /**
   * The cell at absolute indices, built on first request and cached by WRAPPED index —
   * so every repeat of the tile on screen shares one record, and a full tile of cells is
   * the hard upper bound on what this ever holds.
   */
  cell(cx: number, cz: number): VegetationCell {
    const wx = this.wrap(cx);
    const wz = this.wrap(cz);
    const key = wz * this.cellsPerTile + wx;
    let cell = this.cache.get(key);
    if (!cell) {
      cell = this.build(wx, wz);
      this.cache.set(key, cell);
    }
    return cell;
  }

  /** Cells currently held. Bounded by `cellsPerTile²`; exposed for instrumentation. */
  /**
   * Change the density multiplier and discard every cached cell.
   *
   * Cheap by construction: a cell record is rebuilt on demand from
   * (mapSeed, rulesVersion, wrapped index) and the renderer's buffers are sized for the
   * WORST case — every placement site accepted — so no density can overflow them.
   */
  setDensity(density: number): void {
    if (density === this.density) return;
    this.density = density;
    this.cache.clear();
    this.version += 1;
  }

  get cachedCellCount(): number {
    return this.cache.size;
  }

  /**
   * Macro density in [0,1] — clearings and thickets, so the map does not read as an
   * evenly seeded lawn. Value-noise on a lattice that divides the tile exactly, because
   * anything else would not repeat with the terrain.
   */
  macroDensity(x: number, z: number): number {
    const u = ((x + this.terrain.halfWorld) / this.terrain.worldSize) * MACRO_LATTICE;
    const v = ((z + this.terrain.halfWorld) / this.terrain.worldSize) * MACRO_LATTICE;
    const x0 = Math.floor(u);
    const z0 = Math.floor(v);
    const fx = u - x0;
    const fz = v - z0;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const corner = (ix: number, iz: number) => {
      const wxi = ((ix % MACRO_LATTICE) + MACRO_LATTICE) % MACRO_LATTICE;
      const wzi = ((iz % MACRO_LATTICE) + MACRO_LATTICE) % MACRO_LATTICE;
      return hash3i(wxi, wzi, this.mapSeed, SALT_MACRO) / 4294967296;
    };
    const c00 = corner(x0, z0);
    const c10 = corner(x0 + 1, z0);
    const c01 = corner(x0, z0 + 1);
    const c11 = corner(x0 + 1, z0 + 1);
    const top = c00 + (c10 - c00) * sx;
    const bottom = c01 + (c11 - c01) * sx;
    return top + (bottom - top) * sz;
  }

  private build(wx: number, wz: number): VegetationCell {
    const grid = this.placementGrid;
    const step = this.cellSize / grid;
    const originX = this.cellOrigin(wx);
    const originZ = this.cellOrigin(wz);
    const random = rng32(hash3i(wx, wz, this.mapSeed ^ this.rulesVersion, SALT_CELL));

    // Collected per species so the output is grouped without a sort pass.
    const buckets: Array<
      Array<{ ox: number; oz: number; y: number; rot: number; scale: number; seed: number }>
    > = SPECIES.map(() => []);
    let total = 0;
    let maxRadius = 0;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let gz = 0; gz < grid; gz += 1) {
      for (let gx = 0; gx < grid; gx += 1) {
        // Draw every random for this site whether or not it is used, so the stream stays
        // aligned: a rejected site must not shift the decisions of the sites after it.
        const jitterX = random();
        const jitterZ = random();
        const speciesRoll = random();
        const rotationRoll = random();
        const scaleRoll = random();
        const seedRoll = random();

        const ox = (gx + jitterX) * step;
        const oz = (gz + jitterZ) * step;
        const worldX = originX + ox;
        const worldZ = originZ + oz;

        const y = this.terrain.sample(worldX, worldZ);
        const normal = this.terrain.normal(worldX, worldZ, this.normalScratch);
        const macro = this.macroDensity(worldX, worldZ);

        let chosen = -1;
        let threshold = 0;
        for (let s = 0; s < SPECIES.length; s += 1) {
          const species = SPECIES[s];
          if (normal[1] < species.minNormalY) continue;
          if (y < this.waterHeight + species.waterClearanceMetres) continue;
          threshold += species.density * this.density * macro;
          if (speciesRoll < threshold) {
            chosen = s;
            break;
          }
        }
        if (chosen < 0) continue;

        const species = SPECIES[chosen];
        const [minScale, maxScale] = species.scaleRange;
        const scale = minScale + (maxScale - minScale) * scaleRoll;
        buckets[chosen].push({
          ox,
          oz,
          y,
          rot: rotationRoll * Math.PI * 2,
          scale,
          seed: Math.floor(seedRoll * 4294967296) >>> 0,
        });
        total += 1;
        maxRadius = Math.max(maxRadius, species.radiusMetres * scale);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + species.heightMetres * scale);
      }
    }

    if (total === 0) {
      return {
        count: 0,
        offsetX: new Float32Array(0),
        offsetZ: new Float32Array(0),
        baseY: new Float32Array(0),
        rotationY: new Float32Array(0),
        scale: new Float32Array(0),
        seed: new Uint32Array(0),
        speciesRanges: EMPTY_RANGES,
        maxRadius: 0,
        minY: 0,
        maxY: 0,
      };
    }

    const offsetX = new Float32Array(total);
    const offsetZ = new Float32Array(total);
    const baseY = new Float32Array(total);
    const rotationY = new Float32Array(total);
    const scaleOut = new Float32Array(total);
    const seed = new Uint32Array(total);
    const ranges: Array<readonly [number, number]> = [];

    let cursor = 0;
    for (let s = 0; s < buckets.length; s += 1) {
      const bucket = buckets[s];
      ranges.push([cursor, bucket.length] as const);
      for (const plant of bucket) {
        offsetX[cursor] = plant.ox;
        offsetZ[cursor] = plant.oz;
        baseY[cursor] = plant.y;
        rotationY[cursor] = plant.rot;
        scaleOut[cursor] = plant.scale;
        seed[cursor] = plant.seed;
        cursor += 1;
      }
    }

    return {
      count: total,
      offsetX,
      offsetZ,
      baseY,
      rotationY,
      scale: scaleOut,
      seed,
      speciesRanges: ranges,
      maxRadius,
      minY,
      maxY,
    };
  }
}
