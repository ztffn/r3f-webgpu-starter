// The gameplay ray-query contract the ballistic core resolves against.
//
// Three-free on purpose: the browser implements it over registered colliders and
// the analytic heightfield (src/fps/core/WorldQuery.ts), the server over motor
// capsules and the motor height source (src/net/ServerWorldQuery.ts). One
// interface is what keeps client and server terminal ballistics one model.

import type { Damageable } from "./Damageable.ts";
import type { SurfaceId } from "./SurfaceProfile.ts";
import type { Vec3Like } from "./math.ts";

export type WorldHitKind = "terrain" | "target" | "world";

export interface WorldHit {
  readonly distance: number;
  readonly point: Vec3Like;
  readonly normal: Vec3Like | null;
  readonly kind: WorldHitKind;
  readonly objectId: string;
  /** Human-readable name for reports and telemetry; never gameplay identity. */
  readonly objectName: string;
  readonly surfaceId: SurfaceId;
  readonly penetrationThicknessMetres: number;
  readonly damageable: Damageable | null;
}

export interface WorldQuery {
  /**
   * Nearest hit along the ray, or null.
   *
   * `excludeObjectId` skips one registered object for the whole query — a
   * projectile spawns at its shooter's eye, inside the shooter's own capsule,
   * so without it every server-side shot is a guaranteed self-hit.
   */
  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance: number,
    excludeObjectId?: string
  ): WorldHit | null;
}

export interface HeightfieldQuerySource {
  readonly cellSize: number;
  readonly halfWorld: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  sample(x: number, z: number): number;
  normal(x: number, z: number, out?: [number, number, number]): [number, number, number];
}

export interface WorldQueryMetrics {
  readonly raycasts: number;
  readonly terrainQueries: number;
  readonly terrainCellTests: number;
  readonly terrainSamples: number;
  readonly colliderQueries: number;
  readonly colliderCandidates: number;
}
