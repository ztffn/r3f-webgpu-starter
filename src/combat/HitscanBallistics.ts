// Near-field closed-form ballistics: the hitscan half of the hybrid model.
//
// Inside a per-ammunition horizon a round's drop is below tolerance, so the
// authority resolves it instantly along a straight ray — which is what makes
// lag-compensated rewind tractable — using the exact flat-fire solution of the
// same quadratic-drag model the projectile integrator steps. docs/11 §12.

import type { AmmunitionDefinition } from "./AmmunitionDefinition.ts";
import { kineticEnergyJoules } from "./AmmunitionDefinition.ts";
import { DEFAULT_G1_REFERENCE_DRAG_PER_METRE } from "./BallisticModel.ts";
import type { ImpactEvent } from "./ImpactEvent.ts";
import {
  EXIT_EPSILON_METRES,
  resolvePenetration,
  terminalDamageScale,
} from "./PenetrationResolver.ts";
import { SURFACE_PROFILES } from "./SurfaceProfile.ts";
import type { WorldQuery } from "./WorldQuery.ts";
import { MAX_SURFACE_INTERACTIONS } from "./BallisticProjectileSystem.ts";
import type { Vec3Like } from "./math.ts";

const EPSILON = 1e-9;
const GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;

/**
 * Vertical drop the straight-ray approximation is allowed to hide. 5 cm is well
 * under a capsule radius and above the 3.1 cm the two terrain representations
 * already disagree by (docs/12 §7), so hitscan cannot miss anything the
 * simulation could distinguish.
 */
export const DEFAULT_HITSCAN_DROP_BUDGET_METRES = 0.05;

/**
 * The distance inside which a round is resolved as instant hitscan.
 *
 * Derived, not authored: drop ≈ ½·g·(d/v)² stays under the budget while
 * d ≤ v·√(2ε/g), so a fast rifle round earns ~80–95 m and a subsonic or
 * suppressed load automatically earns far less — the lead and drop the shooter
 * must hold at range are exactly the rounds' own physics, never a flat cutoff.
 */
export function hitscanHorizonMetres(
  ammunition: Pick<AmmunitionDefinition, "muzzleVelocityMetresPerSecond">,
  dropBudgetMetres = DEFAULT_HITSCAN_DROP_BUDGET_METRES
): number {
  return (
    ammunition.muzzleVelocityMetresPerSecond *
    Math.sqrt((2 * dropBudgetMetres) / GRAVITY_METRES_PER_SECOND_SQUARED)
  );
}

/**
 * Speed after `distance` metres of free flat-fire flight. The exact solution of
 * dv/ds = -k·v (quadratic drag over distance), so it agrees with the projectile
 * integrator to its step error rather than being a second model.
 */
export function flatFireSpeedAt(
  ammunition: Pick<AmmunitionDefinition, "muzzleVelocityMetresPerSecond" | "ballisticCoefficientG1">,
  distanceMetres: number,
  launchSpeedMetresPerSecond = ammunition.muzzleVelocityMetresPerSecond,
  referenceG1DragPerMetre = DEFAULT_G1_REFERENCE_DRAG_PER_METRE
): number {
  const dragPerMetre = referenceG1DragPerMetre / ammunition.ballisticCoefficientG1;
  return launchSpeedMetresPerSecond * Math.exp(-dragPerMetre * distanceMetres);
}

/** Flight time over `distance` metres of flat fire: t = (e^{k·d} − 1) / (k·v₀). */
export function flatFireElapsedSeconds(
  ammunition: Pick<AmmunitionDefinition, "ballisticCoefficientG1">,
  distanceMetres: number,
  launchSpeedMetresPerSecond: number,
  referenceG1DragPerMetre = DEFAULT_G1_REFERENCE_DRAG_PER_METRE
): number {
  const dragPerMetre = referenceG1DragPerMetre / ammunition.ballisticCoefficientG1;
  if (launchSpeedMetresPerSecond <= EPSILON) return 0;
  return (
    (Math.exp(dragPerMetre * distanceMetres) - 1) /
    (dragPerMetre * launchSpeedMetresPerSecond)
  );
}

export interface HitscanShotInput {
  readonly query: WorldQuery;
  readonly sourceId: string;
  readonly sequence: number;
  readonly origin: Vec3Like;
  /** Need not be normalised. */
  readonly direction: Vec3Like;
  /** The horizon, already bounded by weapon range by the caller. */
  readonly maxDistanceMetres: number;
  readonly damage: number;
  readonly ammunition: AmmunitionDefinition;
  readonly excludeObjectId?: string;
  readonly referenceG1DragPerMetre?: number;
}

/** Launch state of a round that crossed the horizon still flying. */
export interface HitscanContinuation {
  readonly point: Vec3Like;
  readonly direction: Vec3Like;
  readonly speedMetresPerSecond: number;
  readonly distanceTravelledMetres: number;
  readonly elapsedSeconds: number;
  readonly interactionCount: number;
}

export interface HitscanShotResult {
  /** Every surface contact, in order, damage already applied through Damageables. */
  readonly interactions: readonly ImpactEvent[];
  /** Null when the round stopped inside the horizon; else the handoff state. */
  readonly continuation: HitscanContinuation | null;
}

/**
 * Resolves one straight-ray shot: free flight by the closed-form decay, contacts
 * by the shared penetration resolver, damage by the shared §12.3 scale. Returns
 * the handoff state when the round leaves the horizon still moving, so the
 * caller can spawn a continuation projectile that flies the rest with gravity.
 */
export function resolveHitscanShot(input: HitscanShotInput): HitscanShotResult {
  const directionLength = Math.hypot(input.direction.x, input.direction.y, input.direction.z);
  if (!(directionLength > EPSILON) || !(input.maxDistanceMetres > 0)) {
    return { interactions: [], continuation: null };
  }
  const direction: Vec3Like = {
    x: input.direction.x / directionLength,
    y: input.direction.y / directionLength,
    z: input.direction.z / directionLength,
  };
  const referenceDrag = input.referenceG1DragPerMetre ?? DEFAULT_G1_REFERENCE_DRAG_PER_METRE;
  const muzzleEnergy = kineticEnergyJoules(
    input.ammunition,
    input.ammunition.muzzleVelocityMetresPerSecond
  );

  const interactions: ImpactEvent[] = [];
  let position: Vec3Like = input.origin;
  let travelled = 0;
  let elapsed = 0;
  let speed = input.ammunition.muzzleVelocityMetresPerSecond;
  let interactionCount = 0;

  while (interactionCount < MAX_SURFACE_INTERACTIONS && travelled < input.maxDistanceMetres) {
    const remaining = input.maxDistanceMetres - travelled;
    const hit = input.query.raycast(position, direction, remaining, input.excludeObjectId);
    if (hit === null) {
      const exitSpeed = flatFireSpeedAt(input.ammunition, remaining, speed, referenceDrag);
      elapsed += flatFireElapsedSeconds(input.ammunition, remaining, speed, referenceDrag);
      return {
        interactions,
        continuation: {
          point: {
            x: position.x + direction.x * remaining,
            y: position.y + direction.y * remaining,
            z: position.z + direction.z * remaining,
          },
          direction,
          speedMetresPerSecond: exitSpeed,
          distanceTravelledMetres: input.maxDistanceMetres,
          elapsedSeconds: elapsed,
          interactionCount,
        },
      };
    }

    const speedAtContact = flatFireSpeedAt(input.ammunition, hit.distance, speed, referenceDrag);
    elapsed += flatFireElapsedSeconds(input.ammunition, hit.distance, speed, referenceDrag);
    travelled += hit.distance;
    const incidenceCosine = hit.normal
      ? Math.abs(
          direction.x * hit.normal.x + direction.y * hit.normal.y + direction.z * hit.normal.z
        )
      : 1;
    const response = resolvePenetration({
      ammunition: input.ammunition,
      surface: SURFACE_PROFILES[hit.surfaceId],
      speedMetresPerSecond: speedAtContact,
      thicknessMetres: hit.penetrationThicknessMetres,
      incidenceCosine,
    });
    const canContinue =
      response.outcome === "penetrated" && interactionCount < MAX_SURFACE_INTERACTIONS - 1;
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
    let interactionDamage = 0;
    let interactionHealthBefore: number | null = null;
    let interactionHealthAfter: number | null = null;
    let interactionDestroyed = false;
    if (hit.damageable) {
      targetId = hit.damageable.id;
      interactionHealthBefore = hit.damageable.health;
      const damage = hit.damageable.applyDamage({
        amount: input.damage * terminalDamageScale(response.energyBeforeJoules, muzzleEnergy),
        point: hitPoint,
        direction,
        sourceId: input.sourceId,
        shotSequence: input.sequence,
      });
      interactionDamage = damage.applied;
      interactionHealthAfter = damage.health;
      interactionDestroyed = damage.destroyed;
    }

    interactions.push({
      sourceId: input.sourceId,
      shotSequence: input.sequence,
      interactionIndex: interactionCount,
      ammunitionId: input.ammunition.id,
      kind: hit.kind,
      objectId: hit.objectId,
      objectName: hit.objectName,
      targetId,
      damageApplied: interactionDamage,
      healthBefore: interactionHealthBefore,
      healthAfter: interactionHealthAfter,
      destroyed: interactionDestroyed,
      surfaceId: hit.surfaceId,
      outcome: canContinue ? "penetrated" : "stopped",
      point: hitPoint,
      exitPoint,
      normal: hitNormal,
      effectiveThicknessMetres: response.effectiveThicknessMetres,
      speedBeforeMetresPerSecond: speedAtContact,
      speedAfterMetresPerSecond: canContinue ? response.speedAfterMetresPerSecond : 0,
      energyBeforeJoules: response.energyBeforeJoules,
      energyAfterJoules: canContinue ? response.energyAfterJoules : 0,
    });
    interactionCount += 1;

    if (!canContinue || !exitPoint) return { interactions, continuation: null };

    const averageSpeed = Math.max(
      EPSILON,
      (speedAtContact + response.speedAfterMetresPerSecond) * 0.5
    );
    travelled += traversalDistance;
    elapsed += traversalDistance / averageSpeed;
    position = exitPoint;
    speed = response.speedAfterMetresPerSecond;

    if (travelled >= input.maxDistanceMetres) {
      return {
        interactions,
        continuation: {
          point: exitPoint,
          direction,
          speedMetresPerSecond: speed,
          distanceTravelledMetres: travelled,
          elapsedSeconds: elapsed,
          interactionCount,
        },
      };
    }
  }

  return { interactions, continuation: null };
}
