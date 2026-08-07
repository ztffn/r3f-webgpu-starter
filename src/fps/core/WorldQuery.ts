import * as THREE from "three/webgpu";
import type { Damageable } from "../../combat/Damageable.ts";
import {
  DEFAULT_SURFACE_BY_KIND,
  DEFAULT_THICKNESS_BY_KIND,
  type SurfaceId,
} from "../../combat/SurfaceProfile.ts";
import type {
  HeightfieldQuerySource,
  WorldHit as SharedWorldHit,
  WorldHitKind,
  WorldQuery,
  WorldQueryMetrics,
} from "../../combat/WorldQuery.ts";

// The CONTRACT lives in src/combat/WorldQuery.ts, Three-free, because the
// server implements it too. This module is the browser side: implementations
// over registered Three colliders and the analytic heightfield. Re-exported so
// fps consumers keep one import site.
export type {
  HeightfieldQuerySource,
  WorldHitKind,
  WorldQuery,
  WorldQueryMetrics,
} from "../../combat/WorldQuery.ts";

/** Browser hit: the shared shape plus the intersected Three object. */
export interface WorldHit extends SharedWorldHit {
  readonly object: THREE.Object3D;
}

/**
 * An analytic query composed into `CompositeWorldQuery` alongside terrain and colliders.
 *
 * Deliberately NOT the shared `WorldQuery`: that contract is Three-free because the
 * server implements it, so its hit carries no `object`. A source composed here is
 * browser-side and must name the Three object it stands for — one shared proxy for the
 * whole system, exactly as `HeightfieldWorldQuery` does, since the point of a source is
 * that its geometry was never instantiated as scene objects.
 */
export interface WorldQuerySource {
  raycast(
    origin: THREE.Vector3Like,
    direction: THREE.Vector3Like,
    maxDistance: number,
    excludeObjectId?: string
  ): WorldHit | null;
}

export interface WorldQueryRegistration {
  readonly root: THREE.Object3D;
  readonly kind: WorldHitKind;
  readonly objectId?: string;
  readonly surfaceId?: SurfaceId;
  /** Thickness of the simplified ballistic collider along its authored normal. */
  readonly penetrationThicknessMetres?: number;
  readonly damageable?: Damageable;
}

export interface WorldQueryRegistrationHandle {
  (): void;
  /** Re-index a collider after its world transform or bounds change. */
  refresh(): void;
}

export interface RegisteredWorldQuery extends WorldQuery {
  raycast(
    origin: THREE.Vector3Like,
    direction: THREE.Vector3Like,
    maxDistance: number,
    excludeObjectId?: string
  ): WorldHit | null;
  register(registration: WorldQueryRegistration): WorldQueryRegistrationHandle;
  getMetrics(): WorldQueryMetrics;
}

interface IndexedRegistration {
  readonly registration: WorldQueryRegistration;
  readonly occupiedCells: Array<readonly [number, number]>;
  indexed: boolean;
}

const DEFAULT_COLLIDER_CELL_SIZE_METRES = 32;
const MAX_CELLS_PER_COLLIDER = 256;
const DIRECTION_EPSILON = 1e-12;

/**
 * Three.js adapter for explicitly registered gameplay colliders only.
 *
 * Registrations are indexed in X/Z so each ray visits nearby roots instead of
 * recursively walking every registered object. Render terrain must never be
 * registered here; `HeightfieldWorldQuery` is its gameplay representation.
 */
export class ThreeWorldQuery implements RegisteredWorldQuery {
  private readonly raycaster = new THREE.Raycaster();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly bounds = new THREE.Box3();
  private readonly registrations = new Map<WorldQueryRegistration, IndexedRegistration>();
  private readonly ownerByRoot = new Map<THREE.Object3D, WorldQueryRegistration>();
  private readonly cells = new Map<number, Map<number, Set<IndexedRegistration>>>();
  private readonly unindexed = new Set<IndexedRegistration>();
  private readonly candidates = new Set<IndexedRegistration>();
  private readonly candidateRoots: THREE.Object3D[] = [];
  private readonly intersections: THREE.Intersection[] = [];
  private colliderQueries = 0;
  private colliderCandidates = 0;
  private readonly cellSizeMetres: number;

  constructor(layer = 0, cellSizeMetres = DEFAULT_COLLIDER_CELL_SIZE_METRES) {
    if (!Number.isFinite(cellSizeMetres) || !(cellSizeMetres > 0)) {
      throw new Error("World-query collider cell size must be finite and positive");
    }
    this.cellSizeMetres = cellSizeMetres;
    this.raycaster.layers.set(layer);
  }

  register(registration: WorldQueryRegistration): WorldQueryRegistrationHandle {
    const indexed: IndexedRegistration = {
      registration,
      occupiedCells: [],
      indexed: false,
    };
    this.registrations.set(registration, indexed);
    this.ownerByRoot.set(registration.root, registration);
    this.index(indexed);

    const unregister = (() => {
      if (!this.registrations.delete(registration)) return;
      this.removeFromIndex(indexed);
      this.ownerByRoot.delete(registration.root);
    }) as WorldQueryRegistrationHandle;
    unregister.refresh = () => {
      if (!this.registrations.has(registration)) return;
      this.removeFromIndex(indexed);
      this.index(indexed);
    };
    return unregister;
  }

  raycast(
    origin: THREE.Vector3Like,
    direction: THREE.Vector3Like,
    maxDistance: number,
    excludeObjectId?: string
  ): WorldHit | null {
    if (!Number.isFinite(maxDistance) || !(maxDistance > 0)) return null;
    this.direction.set(direction.x, direction.y, direction.z);
    const directionLengthSq = this.direction.lengthSq();
    if (!Number.isFinite(directionLengthSq) || directionLengthSq < Number.EPSILON) {
      return null;
    }
    this.direction.normalize();
    this.origin.set(origin.x, origin.y, origin.z);
    if (
      !Number.isFinite(this.origin.x) ||
      !Number.isFinite(this.origin.y) ||
      !Number.isFinite(this.origin.z)
    ) {
      return null;
    }
    this.colliderQueries += 1;
    this.collectCandidates(this.origin, this.direction, maxDistance);
    this.colliderCandidates += this.candidates.size;
    if (this.candidates.size === 0) return null;

    this.candidateRoots.length = 0;
    for (const candidate of this.candidates) {
      const registration = candidate.registration;
      // Exclusion matches the registration's stable identity; a collider
      // registered without one cannot be excluded, deliberately.
      if (excludeObjectId !== undefined && registrationIdOf(registration) === excludeObjectId) {
        continue;
      }
      this.candidateRoots.push(registration.root);
    }
    if (this.candidateRoots.length === 0) return null;
    this.raycaster.near = 0;
    this.raycaster.far = maxDistance;
    this.raycaster.set(this.origin, this.direction);
    this.intersections.length = 0;
    this.raycaster.intersectObjects(this.candidateRoots, true, this.intersections);
    const nearest = this.intersections[0];
    if (!nearest) return null;

    let owner: WorldQueryRegistration | undefined;
    let candidate: THREE.Object3D | null = nearest.object;
    while (candidate && !owner) {
      owner = this.ownerByRoot.get(candidate);
      candidate = candidate.parent;
    }
    if (!owner) return null;

    const thickness = owner.penetrationThicknessMetres ?? DEFAULT_THICKNESS_BY_KIND[owner.kind];
    return {
      distance: nearest.distance,
      point: nearest.point.clone(),
      normal: nearest.face?.normal.clone().transformDirection(nearest.object.matrixWorld) ?? null,
      kind: owner.kind,
      objectId: registrationIdOf(owner) || nearest.object.uuid,
      objectName: nearest.object.name,
      surfaceId: owner.surfaceId ?? DEFAULT_SURFACE_BY_KIND[owner.kind],
      penetrationThicknessMetres:
        Number.isFinite(thickness) && thickness >= 0
          ? thickness
          : DEFAULT_THICKNESS_BY_KIND[owner.kind],
      damageable: owner.damageable ?? null,
      object: nearest.object,
    };
  }

  getMetrics(): WorldQueryMetrics {
    return {
      raycasts: this.colliderQueries,
      terrainQueries: 0,
      terrainCellTests: 0,
      terrainSamples: 0,
      colliderQueries: this.colliderQueries,
      colliderCandidates: this.colliderCandidates,
    };
  }

  private index(indexed: IndexedRegistration): void {
    const root = indexed.registration.root;
    root.updateWorldMatrix(true, true);
    this.bounds.setFromObject(root);
    if (this.bounds.isEmpty()) {
      this.unindexed.add(indexed);
      return;
    }

    const minX = Math.floor(this.bounds.min.x / this.cellSizeMetres);
    const maxX = Math.floor(this.bounds.max.x / this.cellSizeMetres);
    const minZ = Math.floor(this.bounds.min.z / this.cellSizeMetres);
    const maxZ = Math.floor(this.bounds.max.z / this.cellSizeMetres);
    const cellCount = (maxX - minX + 1) * (maxZ - minZ + 1);
    if (!Number.isFinite(cellCount) || cellCount > MAX_CELLS_PER_COLLIDER) {
      this.unindexed.add(indexed);
      return;
    }

    for (let x = minX; x <= maxX; x += 1) {
      let column = this.cells.get(x);
      if (!column) {
        column = new Map();
        this.cells.set(x, column);
      }
      for (let z = minZ; z <= maxZ; z += 1) {
        let cell = column.get(z);
        if (!cell) {
          cell = new Set();
          column.set(z, cell);
        }
        cell.add(indexed);
        indexed.occupiedCells.push([x, z]);
      }
    }
    indexed.indexed = true;
  }

  private removeFromIndex(indexed: IndexedRegistration): void {
    this.unindexed.delete(indexed);
    if (!indexed.indexed) return;
    for (const [x, z] of indexed.occupiedCells) {
      const column = this.cells.get(x);
      const cell = column?.get(z);
      cell?.delete(indexed);
      if (cell?.size === 0) column?.delete(z);
      if (column?.size === 0) this.cells.delete(x);
    }
    indexed.occupiedCells.length = 0;
    indexed.indexed = false;
  }

  private collectCandidates(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number
  ): void {
    this.candidates.clear();
    for (const registration of this.unindexed) this.candidates.add(registration);

    let cellX = Math.floor(origin.x / this.cellSizeMetres);
    let cellZ = Math.floor(origin.z / this.cellSizeMetres);
    const stepX = direction.x > DIRECTION_EPSILON ? 1 : direction.x < -DIRECTION_EPSILON ? -1 : 0;
    const stepZ = direction.z > DIRECTION_EPSILON ? 1 : direction.z < -DIRECTION_EPSILON ? -1 : 0;
    const deltaX = stepX === 0 ? Infinity : this.cellSizeMetres / Math.abs(direction.x);
    const deltaZ = stepZ === 0 ? Infinity : this.cellSizeMetres / Math.abs(direction.z);
    const boundaryX = stepX > 0 ? (cellX + 1) * this.cellSizeMetres : cellX * this.cellSizeMetres;
    const boundaryZ = stepZ > 0 ? (cellZ + 1) * this.cellSizeMetres : cellZ * this.cellSizeMetres;
    let nextX = stepX === 0 ? Infinity : (boundaryX - origin.x) / direction.x;
    let nextZ = stepZ === 0 ? Infinity : (boundaryZ - origin.z) / direction.z;
    const maxCells =
      Math.ceil(
        ((Math.abs(direction.x) + Math.abs(direction.z)) * maxDistance) /
          this.cellSizeMetres
      ) + 4;

    for (let visited = 0; visited < maxCells; visited += 1) {
      const cell = this.cells.get(cellX)?.get(cellZ);
      if (cell) for (const registration of cell) this.candidates.add(registration);
      const next = Math.min(nextX, nextZ);
      if (next > maxDistance || !Number.isFinite(next)) break;
      const crossesX = nextX <= nextZ + DIRECTION_EPSILON;
      const crossesZ = nextZ <= nextX + DIRECTION_EPSILON;
      if (crossesX) {
        cellX += stepX;
        nextX += deltaX;
      }
      if (crossesZ) {
        cellZ += stepZ;
        nextZ += deltaZ;
      }
    }
  }
}

/**
 * A registration's stable identity, computed ONE way for both the hit result
 * and exclusion — two fallback chains here would let a collider answer to one
 * id when hit and a different id when excluded.
 */
function registrationIdOf(registration: WorldQueryRegistration): string {
  return registration.objectId || registration.root.name;
}

const TERRAIN_ROOT_EPSILON = 1e-7;

/** Analytic segment query against the canonical bilinear CPU heightfield. */
export class HeightfieldWorldQuery implements WorldQuery {
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly terrainObject = new THREE.Object3D();
  private readonly normalTuple: [number, number, number] = [0, 1, 0];
  private terrainQueries = 0;
  private terrainCellTests = 0;
  private terrainSamples = 0;
  private readonly heightfield: HeightfieldQuerySource;

  constructor(heightfield: HeightfieldQuerySource) {
    if (!Number.isFinite(heightfield.cellSize) || !(heightfield.cellSize > 0)) {
      throw new Error("Heightfield query cell size must be finite and positive");
    }
    this.heightfield = heightfield;
    this.terrainObject.name = "terrain-heightfield-collider";
  }

  raycast(
    origin: THREE.Vector3Like,
    direction: THREE.Vector3Like,
    maxDistance: number
  ): WorldHit | null {
    if (!Number.isFinite(maxDistance) || !(maxDistance > 0)) return null;
    this.origin.set(origin.x, origin.y, origin.z);
    this.direction.set(direction.x, direction.y, direction.z);
    const directionLengthSq = this.direction.lengthSq();
    if (
      !Number.isFinite(this.origin.x) ||
      !Number.isFinite(this.origin.y) ||
      !Number.isFinite(this.origin.z) ||
      !Number.isFinite(directionLengthSq) ||
      directionLengthSq < Number.EPSILON
    ) {
      return null;
    }
    this.direction.normalize();
    this.terrainQueries += 1;

    if (this.origin.y > this.heightfield.maxHeight && this.direction.y >= 0) return null;
    let intervalStart = 0;
    if (this.origin.y > this.heightfield.maxHeight && this.direction.y < 0) {
      intervalStart = (this.heightfield.maxHeight - this.origin.y) / this.direction.y;
      if (intervalStart > maxDistance) return null;
    }

    const startX = this.origin.x + this.direction.x * intervalStart;
    const startZ = this.origin.z + this.direction.z * intervalStart;
    const gridX = (startX + this.heightfield.halfWorld) / this.heightfield.cellSize;
    const gridZ = (startZ + this.heightfield.halfWorld) / this.heightfield.cellSize;
    let cellX = Math.floor(gridX);
    let cellZ = Math.floor(gridZ);
    const stepX = this.direction.x > DIRECTION_EPSILON ? 1 : this.direction.x < -DIRECTION_EPSILON ? -1 : 0;
    const stepZ = this.direction.z > DIRECTION_EPSILON ? 1 : this.direction.z < -DIRECTION_EPSILON ? -1 : 0;
    const deltaX = stepX === 0 ? Infinity : this.heightfield.cellSize / Math.abs(this.direction.x);
    const deltaZ = stepZ === 0 ? Infinity : this.heightfield.cellSize / Math.abs(this.direction.z);
    const boundaryX =
      -this.heightfield.halfWorld +
      (cellX + (stepX > 0 ? 1 : 0)) * this.heightfield.cellSize;
    const boundaryZ =
      -this.heightfield.halfWorld +
      (cellZ + (stepZ > 0 ? 1 : 0)) * this.heightfield.cellSize;
    let nextX = stepX === 0 ? Infinity : intervalStart + (boundaryX - startX) / this.direction.x;
    let nextZ = stepZ === 0 ? Infinity : intervalStart + (boundaryZ - startZ) / this.direction.z;
    const maxCells =
      Math.ceil(
        ((Math.abs(this.direction.x) + Math.abs(this.direction.z)) *
          (maxDistance - intervalStart)) /
          this.heightfield.cellSize
      ) + 4;

    for (let visited = 0; visited < maxCells; visited += 1) {
      const intervalEnd = Math.min(nextX, nextZ, maxDistance);
      this.terrainCellTests += 1;
      const localRoot = this.firstTerrainRoot(intervalStart, intervalEnd);
      if (localRoot !== null) return this.createHit(localRoot);
      if (intervalEnd >= maxDistance) break;

      const crossesX = nextX <= nextZ + DIRECTION_EPSILON;
      const crossesZ = nextZ <= nextX + DIRECTION_EPSILON;
      if (crossesX) {
        cellX += stepX;
        nextX += deltaX;
      }
      if (crossesZ) {
        cellZ += stepZ;
        nextZ += deltaZ;
      }
      intervalStart = intervalEnd;
    }
    return null;
  }

  getMetrics(): WorldQueryMetrics {
    return {
      raycasts: this.terrainQueries,
      terrainQueries: this.terrainQueries,
      terrainCellTests: this.terrainCellTests,
      terrainSamples: this.terrainSamples,
      colliderQueries: 0,
      colliderCandidates: 0,
    };
  }

  private clearanceAt(distance: number): number {
    const x = this.origin.x + this.direction.x * distance;
    const y = this.origin.y + this.direction.y * distance;
    const z = this.origin.z + this.direction.z * distance;
    this.terrainSamples += 1;
    return y - this.heightfield.sample(x, z);
  }

  /** The heightfield is bilinear per cell, so clearance along this interval is quadratic. */
  private firstTerrainRoot(start: number, end: number): number | null {
    const span = end - start;
    const c0 = this.clearanceAt(start);
    if (c0 <= TERRAIN_ROOT_EPSILON) return start;
    if (!(span > TERRAIN_ROOT_EPSILON)) return null;
    const middle = (start + end) * 0.5;
    const cm = this.clearanceAt(middle);
    const c1 = this.clearanceAt(end);
    const a = 2 * (c1 + c0 - 2 * cm);
    const b = c1 - c0 - a;
    const c = c0;
    let first = Infinity;

    if (Math.abs(a) < TERRAIN_ROOT_EPSILON) {
      if (Math.abs(b) >= TERRAIN_ROOT_EPSILON) {
        const root = -c / b;
        if (root >= -TERRAIN_ROOT_EPSILON && root <= 1 + TERRAIN_ROOT_EPSILON) first = root;
      }
    } else {
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= -TERRAIN_ROOT_EPSILON) {
        const rootDiscriminant = Math.sqrt(Math.max(0, discriminant));
        const denominator = 2 * a;
        const firstCandidate = (-b - rootDiscriminant) / denominator;
        const secondCandidate = (-b + rootDiscriminant) / denominator;
        if (
          firstCandidate >= -TERRAIN_ROOT_EPSILON &&
          firstCandidate <= 1 + TERRAIN_ROOT_EPSILON
        ) {
          first = firstCandidate;
        }
        if (
          secondCandidate >= -TERRAIN_ROOT_EPSILON &&
          secondCandidate <= 1 + TERRAIN_ROOT_EPSILON
        ) {
          first = Math.min(first, secondCandidate);
        }
      }
    }
    if (!Number.isFinite(first)) return null;
    return start + THREE.MathUtils.clamp(first, 0, 1) * span;
  }

  private createHit(distance: number): WorldHit {
    const point = new THREE.Vector3(
      this.origin.x + this.direction.x * distance,
      this.origin.y + this.direction.y * distance,
      this.origin.z + this.direction.z * distance
    );
    const tuple = this.heightfield.normal(point.x, point.z, this.normalTuple);
    this.terrainSamples += 4;
    return {
      distance,
      point,
      normal: new THREE.Vector3(tuple[0], tuple[1], tuple[2]),
      kind: "terrain",
      objectId: "terrain-heightfield",
      objectName: this.terrainObject.name,
      surfaceId: "dirt",
      penetrationThicknessMetres: DEFAULT_THICKNESS_BY_KIND.terrain,
      damageable: null,
      object: this.terrainObject,
    };
  }
}

/** Nearest-hit composition of analytic terrain and spatially indexed colliders. */
export class CompositeWorldQuery implements RegisteredWorldQuery {
  private readonly colliders: ThreeWorldQuery;
  private readonly terrain: HeightfieldWorldQuery | null;
  private readonly sources = new Set<WorldQuerySource>();
  private raycasts = 0;

  constructor(heightfield: HeightfieldQuerySource | null, layer = 0) {
    this.colliders = new ThreeWorldQuery(layer);
    this.terrain = heightfield ? new HeightfieldWorldQuery(heightfield) : null;
  }

  /**
   * Adds an analytic query source alongside terrain and registered colliders.
   *
   * For gameplay geometry that exists in bulk and is never instantiated as scene objects
   * — vegetation trunks are the first case. The terrain precedent applies: a system with
   * thousands of identical colliders answers for itself analytically rather than
   * registering thousands of `THREE.Object3D`s for a raycaster to walk.
   */
  addSource(source: WorldQuerySource): () => void {
    this.sources.add(source);
    return () => {
      this.sources.delete(source);
    };
  }

  register(registration: WorldQueryRegistration): WorldQueryRegistrationHandle {
    if (registration.kind === "terrain") {
      throw new Error("Visual terrain registration is forbidden; supply the canonical heightfield");
    }
    return this.colliders.register(registration);
  }

  raycast(
    origin: THREE.Vector3Like,
    direction: THREE.Vector3Like,
    maxDistance: number,
    excludeObjectId?: string
  ): WorldHit | null {
    this.raycasts += 1;
    const terrainHit = this.terrain?.raycast(origin, direction, maxDistance) ?? null;
    let nearest = terrainHit;
    // Terrain bounds every later query: nothing behind the ground can be hit, and the
    // shorter ray is also the cheaper one for the sources that walk a spatial grid.
    let limit = nearest ? Math.min(maxDistance, nearest.distance + TERRAIN_ROOT_EPSILON) : maxDistance;

    const colliderHit = this.colliders.raycast(origin, direction, limit, excludeObjectId);
    if (colliderHit && (!nearest || colliderHit.distance <= nearest.distance)) {
      nearest = colliderHit;
      limit = Math.min(limit, colliderHit.distance + TERRAIN_ROOT_EPSILON);
    }

    // Exclusion is FORWARDED, not dropped. A composite that quietly kept it for its
    // own colliders would make the contract's exclusion invisible in every source at
    // once, which is the worse failure — a caller would believe it had excluded
    // something. Whether a source honours it is that source's business;
    // `VegetationWorldQuery` currently ignores it, which is honest because a shooter
    // is never a tree.
    for (const source of this.sources) {
      const hit = source.raycast(origin, direction, limit, excludeObjectId);
      if (hit && (!nearest || hit.distance <= nearest.distance)) {
        nearest = hit;
        limit = Math.min(limit, hit.distance + TERRAIN_ROOT_EPSILON);
      }
    }
    return nearest;
  }

  getMetrics(): WorldQueryMetrics {
    const terrain = this.terrain?.getMetrics();
    const colliders = this.colliders.getMetrics();
    return {
      raycasts: this.raycasts,
      terrainQueries: terrain?.terrainQueries ?? 0,
      terrainCellTests: terrain?.terrainCellTests ?? 0,
      terrainSamples: terrain?.terrainSamples ?? 0,
      colliderQueries: colliders.colliderQueries,
      colliderCandidates: colliders.colliderCandidates,
    };
  }
}
