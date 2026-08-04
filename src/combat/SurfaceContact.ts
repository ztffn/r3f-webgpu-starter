// One surface contact of the shared ballistic model, resolved in one place.
//
// The projectile integrator and the near-field hitscan walk are two solutions
// of the same flight model; this is the part they must NEVER disagree on —
// penetration, damage application, the exit advance, and the ImpactEvent that
// describes it. Both call here, so agreement is structural, not copy discipline.

import { kineticEnergyJoules, type AmmunitionDefinition } from "./AmmunitionDefinition.ts";
import type { ImpactEvent } from "./ImpactEvent.ts";
import {
  EXIT_EPSILON_METRES,
  resolvePenetration,
  terminalDamageScale,
} from "./PenetrationResolver.ts";
import { SURFACE_PROFILES } from "./SurfaceProfile.ts";
import type { WorldHit } from "./WorldQuery.ts";
import type { Vec3Like } from "./math.ts";

export interface SurfaceContactInput {
  readonly hit: WorldHit;
  /** Unit travel direction at the moment of contact. */
  readonly direction: Vec3Like;
  readonly speedMetresPerSecond: number;
  readonly ammunition: AmmunitionDefinition;
  readonly nominalDamage: number;
  readonly sourceId: string;
  readonly sequence: number;
  readonly interactionIndex: number;
  /** The per-round interaction budget; the last slot always stops the round. */
  readonly maxInteractions: number;
}

export interface SurfaceContactResult {
  /** Damage has already been applied through the hit's Damageable. */
  readonly interaction: ImpactEvent;
  readonly canContinue: boolean;
  readonly exitPoint: Vec3Like | null;
  readonly speedAfterMetresPerSecond: number;
  readonly traversalDistanceMetres: number;
}

export function resolveSurfaceContact(input: SurfaceContactInput): SurfaceContactResult {
  const { hit, direction } = input;
  const incidenceCosine = hit.normal
    ? Math.abs(
        direction.x * hit.normal.x + direction.y * hit.normal.y + direction.z * hit.normal.z
      )
    : 1;
  const response = resolvePenetration({
    ammunition: input.ammunition,
    surface: SURFACE_PROFILES[hit.surfaceId],
    speedMetresPerSecond: input.speedMetresPerSecond,
    thicknessMetres: hit.penetrationThicknessMetres,
    incidenceCosine,
  });
  const canContinue =
    response.outcome === "penetrated" && input.interactionIndex < input.maxInteractions - 1;
  const hitPoint: Vec3Like = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
  const hitNormal: Vec3Like | null = hit.normal
    ? { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z }
    : null;
  const traversalDistance = response.effectiveThicknessMetres + EXIT_EPSILON_METRES;
  const exitPoint: Vec3Like | null = canContinue
    ? {
        x: hitPoint.x + direction.x * traversalDistance,
        y: hitPoint.y + direction.y * traversalDistance,
        z: hitPoint.z + direction.z * traversalDistance,
      }
    : null;

  let targetId: string | null = null;
  let damageApplied = 0;
  let healthBefore: number | null = null;
  let healthAfter: number | null = null;
  let destroyed = false;
  if (hit.damageable) {
    targetId = hit.damageable.id;
    healthBefore = hit.damageable.health;
    const muzzleEnergy = kineticEnergyJoules(
      input.ammunition,
      input.ammunition.muzzleVelocityMetresPerSecond
    );
    // Preserve nominal weapon damage through ordinary flight while still
    // reducing lethality after substantial drag or prior penetration (§12.3).
    const damage = hit.damageable.applyDamage({
      amount: input.nominalDamage * terminalDamageScale(response.energyBeforeJoules, muzzleEnergy),
      point: hitPoint,
      direction: { x: direction.x, y: direction.y, z: direction.z },
      sourceId: input.sourceId,
      shotSequence: input.sequence,
    });
    damageApplied = damage.applied;
    healthAfter = damage.health;
    destroyed = damage.destroyed;
  }

  return {
    interaction: {
      sourceId: input.sourceId,
      shotSequence: input.sequence,
      interactionIndex: input.interactionIndex,
      ammunitionId: input.ammunition.id,
      kind: hit.kind,
      objectId: hit.objectId,
      objectName: hit.objectName,
      targetId,
      damageApplied,
      healthBefore,
      healthAfter,
      destroyed,
      surfaceId: hit.surfaceId,
      outcome: canContinue ? "penetrated" : "stopped",
      point: hitPoint,
      exitPoint,
      normal: hitNormal,
      effectiveThicknessMetres: response.effectiveThicknessMetres,
      speedBeforeMetresPerSecond: input.speedMetresPerSecond,
      speedAfterMetresPerSecond: canContinue ? response.speedAfterMetresPerSecond : 0,
      energyBeforeJoules: response.energyBeforeJoules,
      energyAfterJoules: canContinue ? response.energyAfterJoules : 0,
    },
    canContinue,
    exitPoint,
    speedAfterMetresPerSecond: response.speedAfterMetresPerSecond,
    traversalDistanceMetres: traversalDistance,
  };
}
