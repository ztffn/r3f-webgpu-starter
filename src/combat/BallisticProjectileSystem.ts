// Fixed-step gameplay projectile pool — THE ballistic flight model, shared.
//
// Runs identically in the browser (local shots, presentation) and in Node (the
// authority's beyond-horizon shots), which is why it is Three-free: vectors are
// plain {x,y,z} and the world is reached only through the WorldQuery interface.
// docs/11 §10 and §12 are the spec; behavior here must not fork per runtime.

import type { WorldHit, WorldQuery } from "./WorldQuery.ts";
import type { AmmunitionDefinition } from "./AmmunitionDefinition.ts";
import type { BallisticEnvironment } from "./BallisticEnvironment.ts";
import {
  DEFAULT_G1_REFERENCE_DRAG_PER_METRE,
  integrateBallisticVelocity,
  type MutableVelocity,
} from "./BallisticModel.ts";
import type { ShotResult } from "./ShotResult.ts";
import type { ShotTrace } from "./ShotTrace.ts";
import type { TargetHitReport } from "./TargetHitReport.ts";
import type { ImpactEvent } from "./ImpactEvent.ts";
import { resolveSurfaceContact } from "./SurfaceContact.ts";
import { clamp, lerp, type MutableVec3, type Vec3Like } from "./math.ts";

export interface BallisticShot {
  readonly sourceId: string;
  readonly sequence: number;
  readonly origin: Vec3Like;
  readonly direction: Vec3Like;
  readonly sightDirection?: Vec3Like;
  /**
   * Turret-adjusted mean bore before this shot's dispersion sample. Diagnostics
   * need it separately; without it the dispersed direction gets misreported as
   * scope elevation and windage. Defaults to `direction`.
   */
  readonly boreDirection?: Vec3Like;
  readonly maxDistance: number;
  readonly maxFlightSeconds: number;
  readonly damage: number;
  readonly ammunition: AmmunitionDefinition;
  /** False is intended for authority load tests/remote rounds, not local debug. */
  readonly captureTrace?: boolean;
  /** Skip one object id for the whole flight — the shooter's own capsule. */
  readonly excludeObjectId?: string;
  /**
   * Continuation launch state, for a round that already flew its first stretch
   * somewhere else (the server's near-field hitscan). Speed replaces the muzzle
   * velocity; distance, elapsed time, and interaction count start the budgets
   * where the previous leg left them. Damage scale still measures against TRUE
   * muzzle energy, so a handed-off round wounds exactly like a flown one.
   */
  readonly initialSpeedMetresPerSecond?: number;
  readonly initialDistanceMetres?: number;
  readonly initialElapsedSeconds?: number;
  readonly initialInteractionCount?: number;
}

export interface SpawnedBallisticShot
  extends Omit<BallisticShot, "origin" | "direction" | "sightDirection" | "boreDirection"> {
  readonly origin: Vec3Like;
  readonly direction: Vec3Like;
  readonly sightDirection: Vec3Like;
  readonly boreDirection: Vec3Like;
}

export interface BallisticResult extends ShotResult<SpawnedBallisticShot> {}

export interface BallisticSystemOptions {
  readonly capacity?: number;
  readonly maxTracePoints?: number;
  /** Reference retardation divided by G1 BC, expressed per metre. */
  readonly referenceG1DragPerMetre?: number;
  /**
   * False stops the impact-event queue from being populated at all — for a
   * headless owner (the server) with no presentation to drain it, rather than
   * a ritual no-op drain every tick.
   */
  readonly captureImpactEvents?: boolean;
}

export interface BallisticMetrics {
  readonly active: number;
  readonly peakActive: number;
  readonly spawned: number;
  readonly rejectedSpawns: number;
  readonly completed: number;
  readonly fixedSteps: number;
  readonly segmentQueries: number;
  readonly surfaceInteractions: number;
  readonly droppedImpactEvents: number;
  readonly expiredProjectiles: number;
}

const DEFAULT_CAPACITY = 2_048;
const DEFAULT_TRACE_POINTS = 1_024;
const EPSILON = 1e-9;
export const MAX_SURFACE_INTERACTIONS = 8;
const IMPACT_EVENT_CAPACITY = 4_096;

/**
 * Fixed-capacity, fixed-step gameplay projectile pool. Numeric state is stored
 * in typed arrays; the hot integration loop allocates no projectile objects.
 */
export class BallisticProjectileSystem {
  private readonly worldQuery: WorldQuery;
  private readonly environment: BallisticEnvironment;
  private readonly capacity: number;
  private readonly maxTracePoints: number;
  private readonly referenceG1DragPerMetre: number;
  private readonly captureImpactEvents: boolean;

  private readonly activeSlots: Int32Array;
  private readonly freeSlots: Int32Array;
  private activeCount = 0;
  private freeCount: number;

  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly vz: Float64Array;
  private readonly ox: Float64Array;
  private readonly oy: Float64Array;
  private readonly oz: Float64Array;
  private readonly dx: Float64Array;
  private readonly dy: Float64Array;
  private readonly dz: Float64Array;
  private readonly rightX: Float64Array;
  private readonly rightZ: Float64Array;
  private readonly distance: Float64Array;
  private readonly elapsed: Float64Array;
  private readonly damageApplied: Float64Array;
  private readonly destroyed: Uint8Array;
  private readonly interactionCounts: Uint8Array;
  private readonly traceCounts: Uint16Array;
  private readonly traceBuffers: Array<Float32Array | null>;
  private readonly freeTraceBuffers: Float32Array[] = [];
  private readonly shots: Array<SpawnedBallisticShot | null>;
  private readonly interactions: Array<ImpactEvent[] | null>;
  private readonly reports: Array<TargetHitReport[] | null>;

  private readonly segmentOrigin: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly segmentDirection: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly impactDirection: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly nextVelocity: MutableVelocity = { x: 0, y: 0, z: 0 };
  private accumulator = 0;
  private readonly results: BallisticResult[] = [];
  private readonly impactEvents: ImpactEvent[] = [];

  private peakActive = 0;
  private spawned = 0;
  private rejectedSpawns = 0;
  private completed = 0;
  private fixedSteps = 0;
  private segmentQueries = 0;
  private surfaceInteractions = 0;
  private droppedImpactEvents = 0;
  private expiredProjectiles = 0;

  constructor(
    worldQuery: WorldQuery,
    environment: BallisticEnvironment,
    options: BallisticSystemOptions = {}
  ) {
    this.worldQuery = worldQuery;
    this.environment = environment;
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
    this.maxTracePoints = Math.max(2, Math.floor(options.maxTracePoints ?? DEFAULT_TRACE_POINTS));
    this.referenceG1DragPerMetre =
      options.referenceG1DragPerMetre ?? DEFAULT_G1_REFERENCE_DRAG_PER_METRE;
    this.captureImpactEvents = options.captureImpactEvents ?? true;
    if (!Number.isFinite(this.referenceG1DragPerMetre) || !(this.referenceG1DragPerMetre > 0)) {
      throw new Error("Ballistic reference drag must be finite and positive");
    }
    if (!Number.isFinite(environment.fixedStepSeconds) || !(environment.fixedStepSeconds > 0)) {
      throw new Error("Ballistic fixed step must be finite and positive");
    }
    if (
      !Number.isFinite(environment.maxCatchUpSeconds) ||
      !(environment.maxCatchUpSeconds >= environment.fixedStepSeconds)
    ) {
      throw new Error("Ballistic catch-up window must contain at least one fixed step");
    }
    if (
      ![
        environment.gravity.x,
        environment.gravity.y,
        environment.gravity.z,
        environment.windVelocity.x,
        environment.windVelocity.y,
        environment.windVelocity.z,
      ].every(Number.isFinite)
    ) {
      throw new Error("Ballistic gravity and wind must be finite");
    }

    this.activeSlots = new Int32Array(this.capacity);
    this.freeSlots = new Int32Array(this.capacity);
    this.freeCount = this.capacity;
    for (let i = 0; i < this.capacity; i += 1) this.freeSlots[i] = this.capacity - 1 - i;

    this.px = new Float64Array(this.capacity);
    this.py = new Float64Array(this.capacity);
    this.pz = new Float64Array(this.capacity);
    this.vx = new Float64Array(this.capacity);
    this.vy = new Float64Array(this.capacity);
    this.vz = new Float64Array(this.capacity);
    this.ox = new Float64Array(this.capacity);
    this.oy = new Float64Array(this.capacity);
    this.oz = new Float64Array(this.capacity);
    this.dx = new Float64Array(this.capacity);
    this.dy = new Float64Array(this.capacity);
    this.dz = new Float64Array(this.capacity);
    this.rightX = new Float64Array(this.capacity);
    this.rightZ = new Float64Array(this.capacity);
    this.distance = new Float64Array(this.capacity);
    this.elapsed = new Float64Array(this.capacity);
    this.damageApplied = new Float64Array(this.capacity);
    this.destroyed = new Uint8Array(this.capacity);
    this.interactionCounts = new Uint8Array(this.capacity);
    this.traceCounts = new Uint16Array(this.capacity);
    this.traceBuffers = Array.from({ length: this.capacity }, () => null);
    this.shots = Array.from({ length: this.capacity }, () => null);
    this.interactions = Array.from({ length: this.capacity }, () => null);
    this.reports = Array.from({ length: this.capacity }, () => null);
  }

  spawn(input: BallisticShot): boolean {
    const directionLengthSq =
      input.direction.x * input.direction.x +
      input.direction.y * input.direction.y +
      input.direction.z * input.direction.z;
    const sight = input.sightDirection ?? input.direction;
    const bore = input.boreDirection ?? input.direction;
    const sightLengthSq = sight.x * sight.x + sight.y * sight.y + sight.z * sight.z;
    const boreLengthSq = bore.x * bore.x + bore.y * bore.y + bore.z * bore.z;
    const launchSpeed =
      input.initialSpeedMetresPerSecond ?? input.ammunition.muzzleVelocityMetresPerSecond;
    const initialDistance = input.initialDistanceMetres ?? 0;
    const initialElapsed = input.initialElapsedSeconds ?? 0;
    const initialInteractions = input.initialInteractionCount ?? 0;
    if (
      this.freeCount === 0 ||
      !Number.isFinite(directionLengthSq) ||
      directionLengthSq <= EPSILON ||
      !Number.isFinite(sightLengthSq) ||
      sightLengthSq <= EPSILON ||
      !Number.isFinite(boreLengthSq) ||
      boreLengthSq <= EPSILON ||
      !Number.isFinite(input.origin.x) ||
      !Number.isFinite(input.origin.y) ||
      !Number.isFinite(input.origin.z) ||
      !Number.isFinite(input.maxDistance) ||
      !(input.maxDistance > 0) ||
      !Number.isFinite(input.maxFlightSeconds) ||
      !(input.maxFlightSeconds > 0) ||
      !Number.isFinite(input.damage) ||
      !(input.damage >= 0) ||
      !Number.isFinite(input.ammunition.muzzleVelocityMetresPerSecond) ||
      !(input.ammunition.muzzleVelocityMetresPerSecond > 0) ||
      !Number.isFinite(input.ammunition.ballisticCoefficientG1) ||
      !(input.ammunition.ballisticCoefficientG1 > 0) ||
      !Number.isFinite(input.ammunition.projectileMassKilograms) ||
      !(input.ammunition.projectileMassKilograms > 0) ||
      !Number.isFinite(input.ammunition.penetrationMultiplier) ||
      !(input.ammunition.penetrationMultiplier > 0) ||
      !Number.isFinite(launchSpeed) ||
      !(launchSpeed > 0) ||
      !Number.isFinite(initialDistance) ||
      initialDistance < 0 ||
      initialDistance >= input.maxDistance ||
      !Number.isFinite(initialElapsed) ||
      initialElapsed < 0 ||
      initialElapsed >= input.maxFlightSeconds ||
      !Number.isInteger(initialInteractions) ||
      initialInteractions < 0 ||
      initialInteractions >= MAX_SURFACE_INTERACTIONS
    ) {
      this.rejectedSpawns += 1;
      return false;
    }

    const inverseLength = 1 / Math.sqrt(directionLengthSq);
    const direction: Vec3Like = {
      x: input.direction.x * inverseLength,
      y: input.direction.y * inverseLength,
      z: input.direction.z * inverseLength,
    };
    const inverseSight = 1 / Math.sqrt(sightLengthSq);
    const inverseBore = 1 / Math.sqrt(boreLengthSq);
    const slot = this.freeSlots[--this.freeCount];
    const shot: SpawnedBallisticShot = {
      ...input,
      origin: { x: input.origin.x, y: input.origin.y, z: input.origin.z },
      direction,
      sightDirection: {
        x: sight.x * inverseSight,
        y: sight.y * inverseSight,
        z: sight.z * inverseSight,
      },
      boreDirection: {
        x: bore.x * inverseBore,
        y: bore.y * inverseBore,
        z: bore.z * inverseBore,
      },
    };
    this.shots[slot] = shot;
    this.px[slot] = this.ox[slot] = shot.origin.x;
    this.py[slot] = this.oy[slot] = shot.origin.y;
    this.pz[slot] = this.oz[slot] = shot.origin.z;
    this.dx[slot] = direction.x;
    this.dy[slot] = direction.y;
    this.dz[slot] = direction.z;
    this.vx[slot] = direction.x * launchSpeed;
    this.vy[slot] = direction.y * launchSpeed;
    this.vz[slot] = direction.z * launchSpeed;
    const horizontalRightLength = Math.hypot(direction.z, direction.x);
    if (horizontalRightLength > EPSILON) {
      this.rightX[slot] = -direction.z / horizontalRightLength;
      this.rightZ[slot] = direction.x / horizontalRightLength;
    } else {
      this.rightX[slot] = 1;
      this.rightZ[slot] = 0;
    }
    this.distance[slot] = initialDistance;
    this.elapsed[slot] = initialElapsed;
    this.damageApplied[slot] = 0;
    this.destroyed[slot] = 0;
    this.interactionCounts[slot] = initialInteractions;
    this.interactions[slot] = null;
    this.reports[slot] = null;
    this.traceCounts[slot] = 0;
    if (shot.captureTrace !== false) {
      this.traceBuffers[slot] =
        this.freeTraceBuffers.pop() ?? new Float32Array(this.maxTracePoints * 3);
      this.appendTracePoint(slot, shot.origin.x, shot.origin.y, shot.origin.z);
    }
    this.activeSlots[this.activeCount++] = slot;
    this.spawned += 1;
    this.peakActive = Math.max(this.peakActive, this.activeCount);
    return true;
  }

  update(frameDeltaSeconds: number): void {
    const acceptedDelta = Math.min(
      Math.max(frameDeltaSeconds, 0),
      this.environment.maxCatchUpSeconds
    );
    this.accumulator = Math.min(
      this.accumulator + acceptedDelta,
      this.environment.maxCatchUpSeconds
    );
    const step = this.environment.fixedStepSeconds;
    while (this.accumulator + EPSILON >= step) {
      this.advanceFixedStep(step);
      this.accumulator -= step;
      this.fixedSteps += 1;
    }
  }

  drainResults(visitor: (result: BallisticResult) => void): void {
    for (const result of this.results) visitor(result);
    this.results.length = 0;
  }

  /**
   * Reads every live round's position and velocity, for tracer presentation.
   * A read-only visit over the typed arrays — no allocation, no influence on
   * the simulation, which is what keeps it legal under docs/11 §13.3.
   */
  visitActiveProjectiles(
    visitor: (x: number, y: number, z: number, vx: number, vy: number, vz: number) => void
  ): void {
    for (let activeIndex = 0; activeIndex < this.activeCount; activeIndex += 1) {
      const slot = this.activeSlots[activeIndex];
      visitor(
        this.px[slot],
        this.py[slot],
        this.pz[slot],
        this.vx[slot],
        this.vy[slot],
        this.vz[slot]
      );
    }
  }

  drainImpactEvents(visitor: (event: ImpactEvent) => void): void {
    for (const event of this.impactEvents) visitor(event);
    this.impactEvents.length = 0;
  }

  getMetrics(): BallisticMetrics {
    return {
      active: this.activeCount,
      peakActive: this.peakActive,
      spawned: this.spawned,
      rejectedSpawns: this.rejectedSpawns,
      completed: this.completed,
      fixedSteps: this.fixedSteps,
      segmentQueries: this.segmentQueries,
      surfaceInteractions: this.surfaceInteractions,
      droppedImpactEvents: this.droppedImpactEvents,
      expiredProjectiles: this.expiredProjectiles,
    };
  }

  clear(): void {
    while (this.activeCount > 0) {
      const slot = this.activeSlots[--this.activeCount];
      this.releaseSlot(slot);
    }
    this.results.length = 0;
    this.impactEvents.length = 0;
    this.accumulator = 0;
  }

  private advanceFixedStep(dt: number): void {
    for (let activeIndex = this.activeCount - 1; activeIndex >= 0; activeIndex -= 1) {
      const slot = this.activeSlots[activeIndex];
      const shot = this.shots[slot];
      if (!shot) continue;

      const remainingLifetime = shot.maxFlightSeconds - this.elapsed[slot];
      if (!(remainingLifetime > EPSILON)) {
        this.resolve(
          activeIndex,
          slot,
          null,
          this.vx[slot],
          this.vy[slot],
          this.vz[slot],
          true
        );
        continue;
      }

      const oldVx = this.vx[slot];
      const oldVy = this.vy[slot];
      const oldVz = this.vz[slot];
      integrateBallisticVelocity(
        oldVx,
        oldVy,
        oldVz,
        shot.ammunition.ballisticCoefficientG1,
        this.environment,
        dt,
        this.nextVelocity,
        this.referenceG1DragPerMetre
      );
      const nextVx = this.nextVelocity.x;
      const nextVy = this.nextVelocity.y;
      const nextVz = this.nextVelocity.z;

      let stepX = (oldVx + nextVx) * 0.5 * dt;
      let stepY = (oldVy + nextVy) * 0.5 * dt;
      let stepZ = (oldVz + nextVz) * 0.5 * dt;
      let segmentLength = Math.hypot(stepX, stepY, stepZ);
      const remaining = shot.maxDistance - this.distance[slot];
      const distanceFraction = segmentLength > remaining ? remaining / segmentLength : 1;
      const lifetimeFraction = Math.min(1, remainingLifetime / dt);
      const stepFraction = Math.max(0, Math.min(distanceFraction, lifetimeFraction));
      if (stepFraction < 1) {
        stepX *= stepFraction;
        stepY *= stepFraction;
        stepZ *= stepFraction;
        segmentLength *= stepFraction;
      }

      if (!(segmentLength > EPSILON)) {
        this.resolve(activeIndex, slot, null, oldVx, oldVy, oldVz);
        continue;
      }

      this.segmentOrigin.x = this.px[slot];
      this.segmentOrigin.y = this.py[slot];
      this.segmentOrigin.z = this.pz[slot];
      const inverseSegmentLength = 1 / segmentLength;
      this.segmentDirection.x = stepX * inverseSegmentLength;
      this.segmentDirection.y = stepY * inverseSegmentLength;
      this.segmentDirection.z = stepZ * inverseSegmentLength;
      const segmentHit = this.worldQuery.raycast(
        this.segmentOrigin,
        this.segmentDirection,
        segmentLength,
        shot.excludeObjectId
      );
      this.segmentQueries += 1;
      if (segmentHit) {
        const hitFraction = clamp(segmentHit.distance / segmentLength, 0, 1);
        this.elapsed[slot] += dt * stepFraction * hitFraction;
        this.distance[slot] += segmentHit.distance;
        this.px[slot] = segmentHit.point.x;
        this.py[slot] = segmentHit.point.y;
        this.pz[slot] = segmentHit.point.z;
        this.vx[slot] = lerp(oldVx, nextVx, stepFraction * hitFraction);
        this.vy[slot] = lerp(oldVy, nextVy, stepFraction * hitFraction);
        this.vz[slot] = lerp(oldVz, nextVz, stepFraction * hitFraction);
        this.appendTracePoint(slot, this.px[slot], this.py[slot], this.pz[slot]);
        this.handleImpact(activeIndex, slot, segmentHit);
        continue;
      }

      this.px[slot] += stepX;
      this.py[slot] += stepY;
      this.pz[slot] += stepZ;
      this.vx[slot] = lerp(oldVx, nextVx, stepFraction);
      this.vy[slot] = lerp(oldVy, nextVy, stepFraction);
      this.vz[slot] = lerp(oldVz, nextVz, stepFraction);
      this.elapsed[slot] += dt * stepFraction;
      this.distance[slot] += segmentLength;
      if (shot.captureTrace !== false) {
        this.appendTracePoint(slot, this.px[slot], this.py[slot], this.pz[slot]);
      }
      const expired = this.elapsed[slot] + EPSILON >= shot.maxFlightSeconds;
      if (this.distance[slot] + EPSILON >= shot.maxDistance || expired) {
        this.appendTracePoint(slot, this.px[slot], this.py[slot], this.pz[slot]);
        this.resolve(
          activeIndex,
          slot,
          null,
          this.vx[slot],
          this.vy[slot],
          this.vz[slot],
          expired
        );
      }
    }
  }

  private handleImpact(activeIndex: number, slot: number, hit: WorldHit): void {
    const shot = this.shots[slot];
    if (!shot) return;
    const speedBefore = Math.hypot(this.vx[slot], this.vy[slot], this.vz[slot]);
    if (!(speedBefore > EPSILON)) {
      this.resolve(activeIndex, slot, hit, this.vx[slot], this.vy[slot], this.vz[slot]);
      return;
    }

    const inverseSpeed = 1 / speedBefore;
    this.impactDirection.x = this.vx[slot] * inverseSpeed;
    this.impactDirection.y = this.vy[slot] * inverseSpeed;
    this.impactDirection.z = this.vz[slot] * inverseSpeed;
    const contact = resolveSurfaceContact({
      hit,
      direction: this.impactDirection,
      speedMetresPerSecond: speedBefore,
      ammunition: shot.ammunition,
      nominalDamage: shot.damage,
      sourceId: shot.sourceId,
      sequence: shot.sequence,
      interactionIndex: this.interactionCounts[slot],
      maxInteractions: MAX_SURFACE_INTERACTIONS,
    });
    const interaction = contact.interaction;

    if (interaction.targetId !== null) {
      this.damageApplied[slot] += interaction.damageApplied;
      if (interaction.destroyed) this.destroyed[slot] = 1;
      const report: TargetHitReport = {
        targetId: interaction.targetId,
        objectName: hit.objectName,
        sourceId: shot.sourceId,
        shotSequence: shot.sequence,
        point: interaction.point,
        normal: interaction.normal,
        rangeMetres: Math.hypot(
          interaction.point.x - shot.origin.x,
          interaction.point.y - shot.origin.y,
          interaction.point.z - shot.origin.z
        ),
        damageApplied: interaction.damageApplied,
        healthBefore: interaction.healthBefore ?? 0,
        healthAfter: interaction.healthAfter ?? 0,
        destroyed: interaction.destroyed,
      };
      (this.reports[slot] ??= []).push(report);
    }

    this.interactionCounts[slot] += 1;
    this.surfaceInteractions += 1;
    (this.interactions[slot] ??= []).push(interaction);
    if (this.captureImpactEvents) {
      if (this.impactEvents.length < IMPACT_EVENT_CAPACITY) this.impactEvents.push(interaction);
      else this.droppedImpactEvents += 1;
    }

    if (!contact.canContinue || !contact.exitPoint) {
      this.resolve(activeIndex, slot, hit, this.vx[slot], this.vy[slot], this.vz[slot]);
      return;
    }

    const exitPoint = contact.exitPoint;
    const averageSpeed = Math.max(
      EPSILON,
      (speedBefore + contact.speedAfterMetresPerSecond) * 0.5
    );
    this.distance[slot] += contact.traversalDistanceMetres;
    this.elapsed[slot] += contact.traversalDistanceMetres / averageSpeed;
    this.px[slot] = exitPoint.x;
    this.py[slot] = exitPoint.y;
    this.pz[slot] = exitPoint.z;
    this.vx[slot] = this.impactDirection.x * contact.speedAfterMetresPerSecond;
    this.vy[slot] = this.impactDirection.y * contact.speedAfterMetresPerSecond;
    this.vz[slot] = this.impactDirection.z * contact.speedAfterMetresPerSecond;
    this.appendTracePoint(slot, exitPoint.x, exitPoint.y, exitPoint.z);

    const expired = this.elapsed[slot] + EPSILON >= shot.maxFlightSeconds;
    if (this.distance[slot] + EPSILON >= shot.maxDistance || expired) {
      this.resolve(
        activeIndex,
        slot,
        null,
        this.vx[slot],
        this.vy[slot],
        this.vz[slot],
        expired
      );
    }
  }

  private resolve(
    activeIndex: number,
    slot: number,
    segmentHit: WorldHit | null,
    impactVx: number,
    impactVy: number,
    impactVz: number,
    expired = false
  ): void {
    const shot = this.shots[slot];
    if (!shot) return;
    const impactSpeed = Math.hypot(impactVx, impactVy, impactVz);
    const impactPoint: Vec3Like = { x: this.px[slot], y: this.py[slot], z: this.pz[slot] };
    const lineOfSightDistance = Math.hypot(
      impactPoint.x - shot.origin.x,
      impactPoint.y - shot.origin.y,
      impactPoint.z - shot.origin.z
    );
    const hit: WorldHit | null = segmentHit
      ? {
          ...segmentHit,
          distance: lineOfSightDistance,
          point: impactPoint,
          normal: segmentHit.normal
            ? { x: segmentHit.normal.x, y: segmentHit.normal.y, z: segmentHit.normal.z }
            : null,
        }
      : null;
    const reports = this.reports[slot] ?? [];
    const report = reports.at(-1) ?? null;
    const damageApplied = this.damageApplied[slot];
    const destroyed = this.destroyed[slot] === 1;

    const displacementX = this.px[slot] - this.ox[slot];
    const displacementY = this.py[slot] - this.oy[slot];
    const displacementZ = this.pz[slot] - this.oz[slot];
    const forward =
      displacementX * this.dx[slot] +
      displacementY * this.dy[slot] +
      displacementZ * this.dz[slot];
    const deviationX = displacementX - this.dx[slot] * forward;
    const deviationY = displacementY - this.dy[slot] * forward;
    const deviationZ = displacementZ - this.dz[slot] * forward;
    const trace: ShotTrace = {
      shotSequence: shot.sequence,
      sourceId: shot.sourceId,
      mode: "ballistic",
      sightDirection: shot.sightDirection,
      boreDirection: shot.boreDirection,
      initialDirection: shot.direction,
      points: this.buildTracePoints(slot, impactPoint),
      interactions: this.interactions[slot] ?? [],
      impact: hit
        ? {
            point: impactPoint,
            normal: hit.normal,
            kind: hit.kind,
            targetId: hit.damageable?.id ?? null,
            objectName: hit.objectName,
          }
        : null,
      flightTimeSeconds: this.elapsed[slot],
      verticalDropMetres: Math.max(0, -deviationY),
      lateralDriftMetres:
        deviationX * this.rightX[slot] + deviationZ * this.rightZ[slot],
      pathLengthMetres: this.distance[slot],
      impactSpeedMetresPerSecond: impactSpeed,
    };
    this.results.push({ shot, hit, damageApplied, destroyed, report, reports, trace });
    if (expired) this.expiredProjectiles += 1;
    this.completed += 1;
    this.removeActive(activeIndex, slot);
  }

  private appendTracePoint(slot: number, x: number, y: number, z: number): void {
    const traceBuffer = this.traceBuffers[slot];
    if (!traceBuffer) return;
    let point = this.traceCounts[slot];
    if (point >= this.maxTracePoints) point = this.maxTracePoints - 1;
    const offset = point * 3;
    traceBuffer[offset] = x;
    traceBuffer[offset + 1] = y;
    traceBuffer[offset + 2] = z;
    if (this.traceCounts[slot] < this.maxTracePoints) this.traceCounts[slot] += 1;
  }

  private buildTracePoints(slot: number, finalPoint: Vec3Like): Vec3Like[] {
    const traceBuffer = this.traceBuffers[slot];
    if (!traceBuffer) {
      const origin = this.shots[slot]!.origin;
      return [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: finalPoint.x, y: finalPoint.y, z: finalPoint.z },
      ];
    }
    const count = this.traceCounts[slot];
    const points = new Array<Vec3Like>(Math.max(2, count));
    for (let point = 0; point < count; point += 1) {
      const offset = point * 3;
      points[point] = {
        x: traceBuffer[offset],
        y: traceBuffer[offset + 1],
        z: traceBuffer[offset + 2],
      };
    }
    if (count === 1) points[1] = { x: finalPoint.x, y: finalPoint.y, z: finalPoint.z };
    return points;
  }

  private removeActive(activeIndex: number, slot: number): void {
    this.activeCount -= 1;
    if (activeIndex !== this.activeCount) {
      this.activeSlots[activeIndex] = this.activeSlots[this.activeCount];
    }
    this.releaseSlot(slot);
  }

  private releaseSlot(slot: number): void {
    this.shots[slot] = null;
    this.interactions[slot] = null;
    this.reports[slot] = null;
    this.damageApplied[slot] = 0;
    this.destroyed[slot] = 0;
    this.interactionCounts[slot] = 0;
    this.traceCounts[slot] = 0;
    const traceBuffer = this.traceBuffers[slot];
    if (traceBuffer) this.freeTraceBuffers.push(traceBuffer);
    this.traceBuffers[slot] = null;
    this.freeSlots[this.freeCount++] = slot;
  }
}
