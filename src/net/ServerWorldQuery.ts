// The authority's implementation of the shared combat WorldQuery.
//
// Capsules and terrain only — THE CAPSULE IS THE HITBOX (docs/10 §10), sized by
// the blended stance the simulation holds, and terrain is the same height source
// the motor collides with. Candidate positions come from a provider so the same
// query serves rewound history (near-field hitscan) and live state (projectiles).

import type { MotorHeightSource } from "../motor/MotorTypes.ts";
import {
  capsuleNormalAt,
  capsuleRayDistance,
  terrainNormalAt,
  terrainRayDistance,
} from "../motor/HitQuery.ts";
import type { Damageable } from "../combat/Damageable.ts";
import type { WorldHit, WorldQuery } from "../combat/WorldQuery.ts";
import type { Vec3Like } from "../combat/math.ts";
import {
  DEFAULT_SURFACE_BY_KIND,
  DEFAULT_THICKNESS_BY_KIND,
} from "../combat/SurfaceProfile.ts";

/** One shootable capsule: identity plus already-blended dimensions. */
export interface CapsuleCandidate {
  readonly id: number;
  readonly feetX: number;
  readonly feetY: number;
  readonly feetZ: number;
  readonly radius: number;
  readonly height: number;
  /** Report/telemetry name. Players default to `player-<id>`. */
  readonly name?: string;
}

export class ServerWorldQuery implements WorldQuery {
  private readonly heights: MotorHeightSource | null;
  private readonly candidates: () => Iterable<CapsuleCandidate>;
  private readonly damageableFor: (id: number) => Damageable | null;

  constructor(
    heights: MotorHeightSource | null,
    candidates: () => Iterable<CapsuleCandidate>,
    damageableFor: (id: number) => Damageable | null
  ) {
    this.heights = heights;
    this.candidates = candidates;
    this.damageableFor = damageableFor;
  }

  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance: number,
    excludeObjectId?: string
  ): WorldHit | null {
    if (!Number.isFinite(maxDistance) || !(maxDistance > 0)) return null;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (
      !(length > 1e-12) ||
      !Number.isFinite(origin.x) ||
      !Number.isFinite(origin.y) ||
      !Number.isFinite(origin.z)
    ) {
      return null;
    }
    const dirX = direction.x / length;
    const dirY = direction.y / length;
    const dirZ = direction.z / length;

    const terrain =
      this.heights === null
        ? null
        : terrainRayDistance(
            origin.x,
            origin.y,
            origin.z,
            dirX,
            dirY,
            dirZ,
            maxDistance,
            this.heights
          );

    let nearest: CapsuleCandidate | null = null;
    let nearestDistance = terrain ?? maxDistance;
    // Numeric once, compared numerically per candidate: String(id) per capsule
    // per raycast is an allocation on the 120 Hz projectile path. A non-numeric
    // exclusion id parses to NaN and matches nothing, same as before.
    const excludeId = excludeObjectId === undefined ? null : Number(excludeObjectId);
    for (const candidate of this.candidates()) {
      if (excludeId !== null && candidate.id === excludeId) continue;
      const distance = capsuleRayDistance(
        origin.x,
        origin.y,
        origin.z,
        dirX,
        dirY,
        dirZ,
        candidate.feetX,
        candidate.feetY,
        candidate.feetZ,
        candidate.radius,
        candidate.height
      );
      if (distance === null || distance > nearestDistance) continue;
      nearestDistance = distance;
      nearest = candidate;
    }

    if (nearest !== null) {
      const point: Vec3Like = {
        x: origin.x + dirX * nearestDistance,
        y: origin.y + dirY * nearestDistance,
        z: origin.z + dirZ * nearestDistance,
      };
      return {
        distance: nearestDistance,
        point,
        normal: capsuleNormalAt(
          point.x,
          point.y,
          point.z,
          nearest.feetX,
          nearest.feetY,
          nearest.feetZ,
          nearest.radius,
          nearest.height
        ),
        kind: "target",
        objectId: String(nearest.id),
        objectName: nearest.name ?? `player-${nearest.id}`,
        surfaceId: DEFAULT_SURFACE_BY_KIND.target,
        // The whole body along the ray, as the simulation sizes it: a round
        // that keeps enough energy through a diameter of flesh keeps flying.
        penetrationThicknessMetres: nearest.radius * 2,
        damageable: this.damageableFor(nearest.id),
      };
    }

    if (terrain === null || terrain > maxDistance) return null;
    const point: Vec3Like = {
      x: origin.x + dirX * terrain,
      y: origin.y + dirY * terrain,
      z: origin.z + dirZ * terrain,
    };
    return {
      distance: terrain,
      point,
      normal: terrainNormalAt(this.heights!, point.x, point.z),
      kind: "terrain",
      objectId: "terrain-heightfield",
      objectName: "terrain",
      surfaceId: DEFAULT_SURFACE_BY_KIND.terrain,
      penetrationThicknessMetres: DEFAULT_THICKNESS_BY_KIND.terrain,
      damageable: null,
    };
  }
}
