import * as THREE from "three/webgpu";
import type { WorldQuery } from "../core/WorldQuery";
import type { ShotTrace } from "../../combat/ShotTrace.ts";
import type { ShotResult } from "../../combat/ShotResult.ts";

export interface HitscanShot {
  readonly sourceId: string;
  readonly sequence: number;
  readonly origin: THREE.Vector3Like;
  readonly direction: THREE.Vector3Like;
  readonly maxDistance: number;
  readonly damage: number;
}

export interface HitscanResult extends ShotResult<HitscanShot> {}

export class HitscanResolver {
  private readonly worldQuery: WorldQuery;

  constructor(worldQuery: WorldQuery) {
    this.worldQuery = worldQuery;
  }

  resolve(shot: HitscanShot): HitscanResult {
    const hit = this.worldQuery.raycast(shot.origin, shot.direction, shot.maxDistance);
    const origin = new THREE.Vector3(shot.origin.x, shot.origin.y, shot.origin.z);
    const direction = new THREE.Vector3(shot.direction.x, shot.direction.y, shot.direction.z);
    if (direction.lengthSq() > Number.EPSILON) direction.normalize();
    const end = hit
      ? new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z)
      : origin.clone().addScaledVector(direction, shot.maxDistance);
    const trace: ShotTrace = {
      shotSequence: shot.sequence,
      sourceId: shot.sourceId,
      mode: "hitscan",
      sightDirection: direction.clone(),
      // Hitscan has no turret adjustment or dispersion sample, so all three
      // direction concepts collapse onto the supplied direction.
      boreDirection: direction.clone(),
      initialDirection: direction.clone(),
      points: [origin, end],
      interactions: [],
      impact: hit
        ? {
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            normal: hit.normal ? { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } : null,
            kind: hit.kind,
            targetId: hit.damageable?.id ?? null,
            objectName: hit.objectName,
          }
        : null,
      flightTimeSeconds: 0,
      verticalDropMetres: 0,
      lateralDriftMetres: 0,
      pathLengthMetres: hit?.distance ?? shot.maxDistance,
      impactSpeedMetresPerSecond: null,
    };
    if (!hit?.damageable) {
      return { shot, hit, damageApplied: 0, destroyed: false, report: null, reports: [], trace };
    }

    const healthBefore = hit.damageable.health;
    const damage = hit.damageable.applyDamage({
      amount: shot.damage,
      point: hit.point,
      direction: shot.direction,
      sourceId: shot.sourceId,
      shotSequence: shot.sequence,
    });
    const report = {
      targetId: hit.damageable.id,
      objectName: hit.objectName,
      sourceId: shot.sourceId,
      shotSequence: shot.sequence,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      normal: hit.normal ? { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } : null,
      rangeMetres: hit.distance,
      damageApplied: damage.applied,
      healthBefore,
      healthAfter: damage.health,
      destroyed: damage.destroyed,
    };
    return {
      shot,
      hit,
      damageApplied: damage.applied,
      destroyed: damage.destroyed,
      report,
      reports: [report],
      trace,
    };
  }
}
