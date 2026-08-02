import * as THREE from "three/webgpu";
import type { WorldHit, WorldQuery } from "../core/WorldQuery";
import type { AmmunitionDefinition } from "../weapons/AmmunitionDefinition";
import { kineticEnergyJoules } from "../weapons/AmmunitionDefinition.ts";
import type { BallisticEnvironment } from "./BallisticEnvironment";
import {
  DEFAULT_G1_REFERENCE_DRAG_PER_METRE,
  integrateBallisticVelocity,
  type MutableVelocity,
} from "./BallisticModel.ts";
import type { ShotResult } from "./ShotResult";
import type { ShotTrace } from "./ShotTrace";
import type { TargetHitReport } from "./TargetHitReport";
import type { ImpactEvent } from "./ImpactEvent";
import { resolvePenetration } from "./PenetrationResolver.ts";
import { SURFACE_PROFILES } from "./SurfaceProfile.ts";

export interface BallisticShot {
  readonly sourceId: string;
  readonly sequence: number;
  readonly origin: THREE.Vector3Like;
  readonly direction: THREE.Vector3Like;
  readonly sightDirection?: THREE.Vector3Like;
  /**
   * Turret-adjusted mean bore before this shot's dispersion sample. Diagnostics
   * need it separately; without it the dispersed direction gets misreported as
   * scope elevation and windage. Defaults to `direction`.
   */
  readonly boreDirection?: THREE.Vector3Like;
  readonly maxDistance: number;
  readonly maxFlightSeconds: number;
  readonly damage: number;
  readonly ammunition: AmmunitionDefinition;
  /** False is intended for authority load tests/remote rounds, not local debug. */
  readonly captureTrace?: boolean;
}

export interface SpawnedBallisticShot
  extends Omit<BallisticShot, "origin" | "direction" | "sightDirection" | "boreDirection"> {
  readonly origin: THREE.Vector3;
  readonly direction: THREE.Vector3;
  readonly sightDirection: THREE.Vector3;
  readonly boreDirection: THREE.Vector3;
}

export interface BallisticResult extends ShotResult<SpawnedBallisticShot> {}

export interface BallisticSystemOptions {
  readonly capacity?: number;
  readonly maxTracePoints?: number;
  /** Reference retardation divided by G1 BC, expressed per metre. */
  readonly referenceG1DragPerMetre?: number;
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
const EXIT_EPSILON_METRES = 0.002;
const MAX_SURFACE_INTERACTIONS = 8;
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

  private readonly segmentOrigin = new THREE.Vector3();
  private readonly segmentDirection = new THREE.Vector3();
  private readonly impactDirection = new THREE.Vector3();
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
    const direction = new THREE.Vector3(input.direction.x, input.direction.y, input.direction.z);
    const sightDirection = new THREE.Vector3(
      input.sightDirection?.x ?? direction.x,
      input.sightDirection?.y ?? direction.y,
      input.sightDirection?.z ?? direction.z
    );
    const boreDirection = new THREE.Vector3(
      input.boreDirection?.x ?? direction.x,
      input.boreDirection?.y ?? direction.y,
      input.boreDirection?.z ?? direction.z
    );
    const directionLengthSq = direction.lengthSq();
    const sightDirectionLengthSq = sightDirection.lengthSq();
    const boreDirectionLengthSq = boreDirection.lengthSq();
    if (
      this.freeCount === 0 ||
      !Number.isFinite(directionLengthSq) ||
      directionLengthSq <= EPSILON ||
      !Number.isFinite(sightDirectionLengthSq) ||
      sightDirectionLengthSq <= EPSILON ||
      !Number.isFinite(boreDirectionLengthSq) ||
      boreDirectionLengthSq <= EPSILON ||
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
      !(input.ammunition.penetrationMultiplier > 0)
    ) {
      this.rejectedSpawns += 1;
      return false;
    }

    direction.normalize();
    const slot = this.freeSlots[--this.freeCount];
    const shot: SpawnedBallisticShot = {
      ...input,
      origin: new THREE.Vector3(input.origin.x, input.origin.y, input.origin.z),
      direction,
      sightDirection: sightDirection.normalize(),
      boreDirection: boreDirection.normalize(),
    };
    this.shots[slot] = shot;
    this.px[slot] = this.ox[slot] = shot.origin.x;
    this.py[slot] = this.oy[slot] = shot.origin.y;
    this.pz[slot] = this.oz[slot] = shot.origin.z;
    this.dx[slot] = direction.x;
    this.dy[slot] = direction.y;
    this.dz[slot] = direction.z;
    this.vx[slot] = direction.x * input.ammunition.muzzleVelocityMetresPerSecond;
    this.vy[slot] = direction.y * input.ammunition.muzzleVelocityMetresPerSecond;
    this.vz[slot] = direction.z * input.ammunition.muzzleVelocityMetresPerSecond;
    const horizontalRightLength = Math.hypot(direction.z, direction.x);
    if (horizontalRightLength > EPSILON) {
      this.rightX[slot] = -direction.z / horizontalRightLength;
      this.rightZ[slot] = direction.x / horizontalRightLength;
    } else {
      this.rightX[slot] = 1;
      this.rightZ[slot] = 0;
    }
    this.distance[slot] = 0;
    this.elapsed[slot] = 0;
    this.damageApplied[slot] = 0;
    this.destroyed[slot] = 0;
    this.interactionCounts[slot] = 0;
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

      this.segmentOrigin.set(this.px[slot], this.py[slot], this.pz[slot]);
      this.segmentDirection.set(stepX, stepY, stepZ).multiplyScalar(1 / segmentLength);
      const segmentHit = this.worldQuery.raycast(
        this.segmentOrigin,
        this.segmentDirection,
        segmentLength
      );
      this.segmentQueries += 1;
      if (segmentHit) {
        const hitFraction = THREE.MathUtils.clamp(segmentHit.distance / segmentLength, 0, 1);
        this.elapsed[slot] += dt * stepFraction * hitFraction;
        this.distance[slot] += segmentHit.distance;
        this.px[slot] = segmentHit.point.x;
        this.py[slot] = segmentHit.point.y;
        this.pz[slot] = segmentHit.point.z;
        this.vx[slot] = THREE.MathUtils.lerp(oldVx, nextVx, stepFraction * hitFraction);
        this.vy[slot] = THREE.MathUtils.lerp(oldVy, nextVy, stepFraction * hitFraction);
        this.vz[slot] = THREE.MathUtils.lerp(oldVz, nextVz, stepFraction * hitFraction);
        this.appendTracePoint(slot, this.px[slot], this.py[slot], this.pz[slot]);
        this.handleImpact(activeIndex, slot, segmentHit);
        continue;
      }

      this.px[slot] += stepX;
      this.py[slot] += stepY;
      this.pz[slot] += stepZ;
      this.vx[slot] = THREE.MathUtils.lerp(oldVx, nextVx, stepFraction);
      this.vy[slot] = THREE.MathUtils.lerp(oldVy, nextVy, stepFraction);
      this.vz[slot] = THREE.MathUtils.lerp(oldVz, nextVz, stepFraction);
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

    this.impactDirection
      .set(this.vx[slot], this.vy[slot], this.vz[slot])
      .multiplyScalar(1 / speedBefore);
    const incidenceCosine = hit.normal
      ? Math.abs(this.impactDirection.dot(hit.normal))
      : 1;
    const response = resolvePenetration({
      ammunition: shot.ammunition,
      surface: SURFACE_PROFILES[hit.surfaceId],
      speedMetresPerSecond: speedBefore,
      thicknessMetres: hit.penetrationThicknessMetres,
      incidenceCosine,
    });
    const interactionIndex = this.interactionCounts[slot];
    const canContinue =
      response.outcome === "penetrated" && interactionIndex < MAX_SURFACE_INTERACTIONS - 1;
    const outcome = canContinue ? "penetrated" : "stopped";
    const exitPoint = canContinue
      ? hit.point
          .clone()
          .addScaledVector(
            this.impactDirection,
            response.effectiveThicknessMetres + EXIT_EPSILON_METRES
          )
      : null;

    let targetId: string | null = null;
    let interactionDamage = 0;
    let interactionHealthBefore: number | null = null;
    let interactionHealthAfter: number | null = null;
    let interactionDestroyed = false;
    if (hit.damageable) {
      targetId = hit.damageable.id;
      const healthBefore = hit.damageable.health;
      interactionHealthBefore = healthBefore;
      const muzzleEnergy = kineticEnergyJoules(
        shot.ammunition,
        shot.ammunition.muzzleVelocityMetresPerSecond
      );
      // Preserve nominal weapon damage through ordinary flight while still
      // reducing lethality after substantial drag or prior penetration.
      const damageScale = THREE.MathUtils.clamp(
        response.energyBeforeJoules / (muzzleEnergy * 0.7),
        0.1,
        1
      );
      const damage = hit.damageable.applyDamage({
        amount: shot.damage * damageScale,
        point: hit.point,
        direction: this.impactDirection,
        sourceId: shot.sourceId,
        shotSequence: shot.sequence,
      });
      this.damageApplied[slot] += damage.applied;
      if (damage.destroyed) this.destroyed[slot] = 1;
      interactionDamage = damage.applied;
      interactionHealthAfter = damage.health;
      interactionDestroyed = damage.destroyed;
      const report: TargetHitReport = {
        targetId,
        objectName: hit.object.name,
        sourceId: shot.sourceId,
        shotSequence: shot.sequence,
        point: hit.point.clone(),
        normal: hit.normal?.clone() ?? null,
        rangeMetres: shot.origin.distanceTo(hit.point),
        damageApplied: damage.applied,
        healthBefore,
        healthAfter: damage.health,
        destroyed: damage.destroyed,
      };
      (this.reports[slot] ??= []).push(report);
    }

    const interaction: ImpactEvent = {
      sourceId: shot.sourceId,
      shotSequence: shot.sequence,
      interactionIndex,
      ammunitionId: shot.ammunition.id,
      kind: hit.kind,
      objectId: hit.objectId,
      objectName: hit.object.name,
      targetId,
      damageApplied: interactionDamage,
      healthBefore: interactionHealthBefore,
      healthAfter: interactionHealthAfter,
      destroyed: interactionDestroyed,
      surfaceId: hit.surfaceId,
      outcome,
      point: hit.point.clone(),
      exitPoint,
      normal: hit.normal?.clone() ?? null,
      effectiveThicknessMetres: response.effectiveThicknessMetres,
      speedBeforeMetresPerSecond: speedBefore,
      speedAfterMetresPerSecond: canContinue ? response.speedAfterMetresPerSecond : 0,
      energyBeforeJoules: response.energyBeforeJoules,
      energyAfterJoules: canContinue ? response.energyAfterJoules : 0,
    };
    this.interactionCounts[slot] += 1;
    this.surfaceInteractions += 1;
    (this.interactions[slot] ??= []).push(interaction);
    if (this.impactEvents.length < IMPACT_EVENT_CAPACITY) this.impactEvents.push(interaction);
    else this.droppedImpactEvents += 1;

    if (!canContinue || !exitPoint) {
      this.resolve(activeIndex, slot, hit, this.vx[slot], this.vy[slot], this.vz[slot]);
      return;
    }

    const traversalDistance = response.effectiveThicknessMetres + EXIT_EPSILON_METRES;
    const averageSpeed = Math.max(
      EPSILON,
      (speedBefore + response.speedAfterMetresPerSecond) * 0.5
    );
    this.distance[slot] += traversalDistance;
    this.elapsed[slot] += traversalDistance / averageSpeed;
    this.px[slot] = exitPoint.x;
    this.py[slot] = exitPoint.y;
    this.pz[slot] = exitPoint.z;
    this.vx[slot] = this.impactDirection.x * response.speedAfterMetresPerSecond;
    this.vy[slot] = this.impactDirection.y * response.speedAfterMetresPerSecond;
    this.vz[slot] = this.impactDirection.z * response.speedAfterMetresPerSecond;
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
    const impactPoint = new THREE.Vector3(this.px[slot], this.py[slot], this.pz[slot]);
    const lineOfSightDistance = shot.origin.distanceTo(impactPoint);
    const hit: WorldHit | null = segmentHit
      ? {
          ...segmentHit,
          distance: lineOfSightDistance,
          point: impactPoint,
          normal: segmentHit.normal?.clone() ?? null,
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
      sightDirection: shot.sightDirection.clone(),
      boreDirection: shot.boreDirection.clone(),
      initialDirection: shot.direction.clone(),
      points: this.buildTracePoints(slot, impactPoint),
      interactions: this.interactions[slot] ?? [],
      impact: hit
        ? {
            point: impactPoint.clone(),
            normal: hit.normal?.clone() ?? null,
            kind: hit.kind,
            targetId: hit.damageable?.id ?? null,
            objectName: hit.object.name,
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

  private buildTracePoints(slot: number, finalPoint: THREE.Vector3): THREE.Vector3[] {
    const traceBuffer = this.traceBuffers[slot];
    if (!traceBuffer) return [this.shots[slot]!.origin.clone(), finalPoint.clone()];
    const count = this.traceCounts[slot];
    const points = new Array<THREE.Vector3>(Math.max(2, count));
    for (let point = 0; point < count; point += 1) {
      const offset = point * 3;
      points[point] = new THREE.Vector3(
        traceBuffer[offset],
        traceBuffer[offset + 1],
        traceBuffer[offset + 2]
      );
    }
    if (count === 1) points[1] = finalPoint.clone();
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
