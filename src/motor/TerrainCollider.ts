// Rapier collision surface for the tiling DF2 terrain.
//
// The map repeats forever (docs/06 §10), so there is no finite collider that
// covers it. This builds a square heightfield window around the player and
// re-centres it on the cell lattice when they walk far enough, which keeps one
// small static collider in the world and never exposes a terrain edge.
//
// Re-centring snaps to whole cells, so the rebuilt surface is bit-identical to
// the one it replaced wherever the two overlap; a player cannot feel a rebuild.

import type RAPIER from "@dimforge/rapier3d-compat";
import type { MotorHeightSource } from "./MotorTypes.ts";

/**
 * A terrain collision surface a motor steps against.
 *
 * The seam exists because the client and the server want different shapes. One
 * local player wants a small window that follows them; a 64-player server room
 * wants ONE surface every motor shares, because 64 following windows is 64
 * heightfield colliders describing largely the same ground.
 */
export interface TerrainSurface {
  /** Returns true if the surface rebuilt. Cheap to call every tick. */
  update(x: number, z: number): boolean;
  dispose(): void;
}

export interface TerrainColliderOptions {
  /** Cells per side of the window. Samples per side is this plus one. */
  readonly windowCells?: number;
  /**
   * Rebuild once the subject is this fraction of a half-window from centre.
   * Below 1 so the rebuild happens before the window edge is anywhere near the
   * body, and the edge is never a surface the character can reach.
   */
  readonly recentreFraction?: number;
  /**
   * Rapier lattice steps per source cell. See `DEFAULT_SUBDIVISION`.
   */
  readonly subdivision?: number;
}

const DEFAULT_WINDOW_CELLS = 128;
const DEFAULT_RECENTRE_FRACTION = 0.5;

/**
 * How finely the Rapier lattice samples the source field, in steps per source
 * cell.
 *
 * This is not a quality knob, it closes a measured gap. Bullets resolve the
 * BILINEAR surface through `CompositeWorldQuery`; a Rapier heightfield is two
 * TRIANGLES per cell. The two agree exactly at cell corners and diverge by the
 * cell's saddle term in between — worst 0.195 m at 2 m cells, which showed up
 * as roughly one grazing shot in four hundred resolving differently between
 * "blocked by cover" and "clear".
 *
 * Sampling the same bilinear field at half the cell size cuts that to 0.031 m
 * for four times the height memory, and each further halving buys another
 * factor of four. Two is the measured sweet spot; see §7.5 of
 * `docs/plans/2026-08-02-motor-measurements.md`.
 */
export const DEFAULT_SUBDIVISION = 2;

/**
 * A re-centring Rapier heightfield tracking a moving subject.
 *
 * Height array layout is column-major with rows along +Z and columns along +X,
 * which is what Rapier's `DMatrix` expects. `tests/motor/terrain-collider.test.ts`
 * probes the built collider against the source field and fails on a transpose,
 * so this comment is checked rather than trusted.
 */
export class TerrainCollider implements TerrainSurface {
  /** Source cells the window spans. Not the Rapier lattice resolution. */
  readonly windowCells: number;
  readonly spanMetres: number;
  readonly subdivision: number;

  /** Number of times the window has been rebuilt. Cheap streaming telemetry. */
  rebuildCount = 0;

  private readonly rapier: typeof RAPIER;
  private readonly world: RAPIER.World;
  private readonly source: MotorHeightSource;
  private readonly heights: Float32Array;
  private readonly samplesPerSide: number;
  private readonly latticeCells: number;
  private readonly latticeStep: number;
  private readonly recentreDistance: number;

  private body: RAPIER.RigidBody | null = null;
  private collider: RAPIER.Collider | null = null;
  private centreX = Number.NaN;
  private centreZ = Number.NaN;

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    source: MotorHeightSource,
    options: TerrainColliderOptions = {}
  ) {
    this.rapier = rapier;
    this.world = world;
    this.source = source;
    this.windowCells = Math.max(2, Math.floor(options.windowCells ?? DEFAULT_WINDOW_CELLS));
    this.subdivision = Math.max(1, Math.floor(options.subdivision ?? DEFAULT_SUBDIVISION));
    this.latticeCells = this.windowCells * this.subdivision;
    this.samplesPerSide = this.latticeCells + 1;
    this.spanMetres = this.windowCells * source.cellSize;
    this.latticeStep = source.cellSize / this.subdivision;
    this.heights = new Float32Array(this.samplesPerSide * this.samplesPerSide);
    this.recentreDistance =
      (this.spanMetres / 2) * (options.recentreFraction ?? DEFAULT_RECENTRE_FRACTION);
  }

  get centre(): { x: number; z: number } {
    return { x: this.centreX, z: this.centreZ };
  }

  /**
   * Re-centres on (x, z) if the window has drifted too far. Returns true when a
   * rebuild happened. Safe and cheap to call every tick.
   */
  update(x: number, z: number): boolean {
    if (
      this.collider !== null &&
      Math.abs(x - this.centreX) < this.recentreDistance &&
      Math.abs(z - this.centreZ) < this.recentreDistance
    ) {
      return false;
    }
    this.rebuild(x, z);
    return true;
  }

  dispose(): void {
    if (this.body !== null) this.world.removeRigidBody(this.body);
    this.body = null;
    this.collider = null;
  }

  private rebuild(x: number, z: number): void {
    const cell = this.source.cellSize;
    // Snapping the centre to the cell lattice is what makes a rebuild invisible:
    // every sample lands on a position the previous window also sampled.
    this.centreX = Math.round(x / cell) * cell;
    this.centreZ = Math.round(z / cell) * cell;

    const n = this.samplesPerSide;
    const half = this.spanMetres / 2;
    const step = this.latticeStep;
    for (let col = 0; col < n; col += 1) {
      const sampleX = this.centreX - half + col * step;
      const columnBase = col * n;
      for (let row = 0; row < n; row += 1) {
        const sampleZ = this.centreZ - half + row * step;
        this.heights[columnBase + row] = this.source.sample(sampleX, sampleZ);
      }
    }

    if (this.body !== null) this.world.removeRigidBody(this.body);
    this.body = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.fixed().setTranslation(this.centreX, 0, this.centreZ)
    );
    this.collider = this.world.createCollider(
      this.rapier.ColliderDesc.heightfield(this.latticeCells, this.latticeCells, this.heights, {
        x: this.spanMetres,
        y: 1,
        z: this.spanMetres,
      }),
      this.body
    );
    this.rebuildCount += 1;
  }
}

/**
 * One fixed heightfield covering a whole region, built once and shared by every
 * motor in a room. This is the server shape: a 2048 m tile at 2 m cells is a
 * 1024x1024 grid, about 4 MB of heights, which is far cheaper than giving each
 * of 64 players a window that follows them.
 *
 * It has real edges, unlike `TerrainCollider`. A player who leaves the region
 * falls through, so the caller must keep the match inside it.
 */
export class StaticTerrainCollider implements TerrainSurface {
  readonly cells: number;
  readonly spanMetres: number;

  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;

  constructor(
    rapier: typeof RAPIER,
    world: RAPIER.World,
    source: MotorHeightSource,
    spanMetres: number,
    centreX = 0,
    centreZ = 0,
    subdivision = DEFAULT_SUBDIVISION
  ) {
    this.world = world;
    this.spanMetres = spanMetres;
    this.cells = Math.max(
      2,
      Math.round(spanMetres / source.cellSize) * Math.max(1, Math.floor(subdivision))
    );

    const n = this.cells + 1;
    const heights = new Float32Array(n * n);
    const half = spanMetres / 2;
    const step = spanMetres / this.cells;
    for (let col = 0; col < n; col += 1) {
      const x = centreX - half + col * step;
      const columnBase = col * n;
      for (let row = 0; row < n; row += 1) {
        heights[columnBase + row] = source.sample(x, centreZ - half + row * step);
      }
    }

    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(centreX, 0, centreZ)
    );
    world.createCollider(
      rapier.ColliderDesc.heightfield(this.cells, this.cells, heights, {
        x: spanMetres,
        y: 1,
        z: spanMetres,
      }),
      this.body
    );
  }

  update(): boolean {
    return false;
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
  }
}
