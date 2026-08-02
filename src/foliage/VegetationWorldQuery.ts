// Ballistic query against vegetation — analytic, over the same records the renderer draws.
//
// WHAT A BULLET HITS, AND WHAT IT DOES NOT
// Leaves are concealment; they stop nothing. Trunks are cover. This query answers ONLY
// the second, which is why it walks trunk cylinders and ignores every leaf card on the
// map. Concealment is a separate question with a separate answer (docs/04), and mixing
// them would give bushes the ballistic behaviour of walls.
//
// WHY NOT REGISTER TREES WITH ThreeWorldQuery
// `ThreeWorldQuery` indexes explicitly registered THREE.Object3D colliders and raycasts
// them. Registering a collider per tree would mean thousands of scene objects and index
// entries for objects the renderer deliberately never instantiates — it would reintroduce
// exactly the per-object cost that instancing exists to avoid, on the gameplay side
// instead of the render side. This follows the precedent the terrain already set:
// `CompositeWorldQuery` FORBIDS registering the visual terrain and takes the canonical
// heightfield instead. Vegetation gets the same treatment, one layer up.
//
// THE PROPERTY THAT MATTERS FOR FAIRNESS
// The proxy is derived from the species table and the instance record, never from the
// drawn mesh. Visual LOD, wind, distance fade and card variant therefore cannot change
// where a bullet stops — which is the research memo's rule, and the same rule docs/08 §8
// invariant 6 states for concealment.

import * as THREE from "three/webgpu";
import type { WorldHit, WorldQuery } from "../fps/core/WorldQuery.ts";
import { SPECIES } from "./species.ts";
import type { VegetationField } from "./VegetationField.ts";

const DIRECTION_EPSILON = 1e-12;

export class VegetationWorldQuery implements WorldQuery {
  private readonly field: VegetationField;
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly proxyObject = new THREE.Object3D();
  private readonly trunkSpecies: number[];
  private queries = 0;
  private cellTests = 0;
  private trunkTests = 0;

  constructor(field: VegetationField) {
    this.field = field;
    this.proxyObject.name = "vegetation-trunk-collider";
    this.trunkSpecies = SPECIES.map((species, index) => (species.trunk ? index : -1)).filter(
      (index) => index >= 0
    );
  }

  getMetrics(): { queries: number; cellTests: number; trunkTests: number } {
    return { queries: this.queries, cellTests: this.cellTests, trunkTests: this.trunkTests };
  }

  raycast(
    origin: THREE.Vector3Like,
    direction: THREE.Vector3Like,
    maxDistance: number
  ): WorldHit | null {
    if (this.trunkSpecies.length === 0) return null;
    if (!Number.isFinite(maxDistance) || !(maxDistance > 0)) return null;
    this.direction.set(direction.x, direction.y, direction.z);
    const lengthSq = this.direction.lengthSq();
    if (!Number.isFinite(lengthSq) || lengthSq < Number.EPSILON) return null;
    this.direction.normalize();
    this.origin.set(origin.x, origin.y, origin.z);
    if (
      !Number.isFinite(this.origin.x) ||
      !Number.isFinite(this.origin.y) ||
      !Number.isFinite(this.origin.z)
    ) {
      return null;
    }
    this.queries += 1;

    const cellSize = this.field.cellSize;
    let cellX = this.field.cellIndexAt(this.origin.x);
    let cellZ = this.field.cellIndexAt(this.origin.z);
    const stepX =
      this.direction.x > DIRECTION_EPSILON ? 1 : this.direction.x < -DIRECTION_EPSILON ? -1 : 0;
    const stepZ =
      this.direction.z > DIRECTION_EPSILON ? 1 : this.direction.z < -DIRECTION_EPSILON ? -1 : 0;
    const deltaX = stepX === 0 ? Infinity : cellSize / Math.abs(this.direction.x);
    const deltaZ = stepZ === 0 ? Infinity : cellSize / Math.abs(this.direction.z);
    const boundaryX = this.field.cellOrigin(cellX + (stepX > 0 ? 1 : 0));
    const boundaryZ = this.field.cellOrigin(cellZ + (stepZ > 0 ? 1 : 0));
    let nextX = stepX === 0 ? Infinity : (boundaryX - this.origin.x) / this.direction.x;
    let nextZ = stepZ === 0 ? Infinity : (boundaryZ - this.origin.z) / this.direction.z;
    const maxCells =
      Math.ceil(
        ((Math.abs(this.direction.x) + Math.abs(this.direction.z)) * maxDistance) / cellSize
      ) + 4;

    // A cell's plants can overhang its boundary, so a trunk found in cell N may sit
    // further along the ray than one in cell N+1. Walking cell by cell and returning the
    // first hit would therefore be wrong at the margin; the nearest hit is kept instead
    // and the walk stops only once the cell entry distance passes it.
    let nearest: WorldHit | null = null;
    let entry = 0;

    for (let visited = 0; visited < maxCells; visited += 1) {
      if (nearest && entry > nearest.distance) break;

      this.cellTests += 1;
      const hit = this.testCell(cellX, cellZ, maxDistance);
      if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;

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
      entry = next;
    }

    return nearest;
  }

  private testCell(cx: number, cz: number, maxDistance: number): WorldHit | null {
    const cell = this.field.cell(cx, cz);
    if (cell.count === 0) return null;
    const cellOriginX = this.field.cellOrigin(cx);
    const cellOriginZ = this.field.cellOrigin(cz);
    let nearest: WorldHit | null = null;

    for (const speciesIndex of this.trunkSpecies) {
      const species = SPECIES[speciesIndex];
      const trunk = species.trunk;
      if (!trunk) continue;
      const range = cell.speciesRanges[speciesIndex];
      if (!range) continue;
      const [start, count] = range;

      for (let i = 0; i < count; i += 1) {
        const source = start + i;
        const scale = cell.scale[source];
        const centreX = cellOriginX + cell.offsetX[source];
        const centreZ = cellOriginZ + cell.offsetZ[source];
        const base = cell.baseY[source];
        const radius = trunk.radiusMetres * scale;
        const top = base + trunk.heightMetres * scale;
        this.trunkTests += 1;

        const distance = this.intersectCylinder(centreX, centreZ, base, top, radius, maxDistance);
        if (distance === null) continue;
        if (nearest && distance >= nearest.distance) continue;

        const point = new THREE.Vector3(
          this.origin.x + this.direction.x * distance,
          this.origin.y + this.direction.y * distance,
          this.origin.z + this.direction.z * distance
        );
        const normal = new THREE.Vector3(point.x - centreX, 0, point.z - centreZ);
        if (normal.lengthSq() < 1e-10) normal.set(0, 1, 0);
        else normal.normalize();

        nearest = {
          distance,
          point,
          normal,
          kind: "world",
          // Deterministic and position-free: derived from the wrapped cell and the
          // instance's index within it, so two machines naming the same tree agree
          // without exchanging anything but the cell coordinates.
          objectId: `vegetation:${species.id}:${this.field.wrap(cx)}:${this.field.wrap(cz)}:${i}`,
          surfaceId: trunk.surfaceId,
          // Scaled with the instance: a bigger tree really is thicker, and a proxy that
          // ignored that would make every trunk on the map stop the same round.
          penetrationThicknessMetres: trunk.penetrationThicknessMetres * scale,
          damageable: null,
          object: this.proxyObject,
        };
      }
    }
    return nearest;
  }

  /** Nearest intersection with a capped vertical cylinder, or null. */
  private intersectCylinder(
    centreX: number,
    centreZ: number,
    base: number,
    top: number,
    radius: number,
    maxDistance: number
  ): number | null {
    const ox = this.origin.x - centreX;
    const oz = this.origin.z - centreZ;
    const dx = this.direction.x;
    const dz = this.direction.z;
    const dy = this.direction.y;
    const a = dx * dx + dz * dz;
    const radiusSq = radius * radius;

    let best = Infinity;

    if (a > 1e-12) {
      const b = 2 * (ox * dx + oz * dz);
      const c = ox * ox + oz * oz - radiusSq;
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= 0) {
        const root = Math.sqrt(discriminant);
        for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
          if (t < 0 || t > maxDistance || t >= best) continue;
          const y = this.origin.y + dy * t;
          if (y < base || y > top) continue;
          best = t;
        }
      }
    }

    // Caps. Cheap, and a shot taken from above a treeline is a real case in a game whose
    // maps are hills and whose engagements start long.
    if (Math.abs(dy) > 1e-9) {
      for (const planeY of [base, top]) {
        const t = (planeY - this.origin.y) / dy;
        if (t < 0 || t > maxDistance || t >= best) continue;
        const px = ox + dx * t;
        const pz = oz + dz * t;
        if (px * px + pz * pz > radiusSq) continue;
        best = t;
      }
    }

    return Number.isFinite(best) ? best : null;
  }
}
