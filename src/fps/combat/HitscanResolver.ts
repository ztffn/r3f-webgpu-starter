import * as THREE from "three/webgpu";
import type { WorldHit, WorldQuery } from "../core/WorldQuery";
import type { ShotTrace } from "./ShotTrace";
import type { TargetHitReport } from "./TargetHitReport";

export interface HitscanShot {
  readonly sourceId: string;
  readonly sequence: number;
  readonly origin: THREE.Vector3Like;
  readonly direction: THREE.Vector3Like;
  readonly maxDistance: number;
  readonly damage: number;
}

export interface HitscanResult {
  readonly shot: HitscanShot;
  readonly hit: WorldHit | null;
  readonly damageApplied: number;
  readonly destroyed: boolean;
  readonly report: TargetHitReport | null;
  readonly trace: ShotTrace;
}

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
    const end = hit?.point.clone() ?? origin.clone().addScaledVector(direction, shot.maxDistance);
    const trace: ShotTrace = {
      shotSequence: shot.sequence,
      sourceId: shot.sourceId,
      mode: "hitscan",
      points: [origin, end],
      impact: hit
        ? {
            point: hit.point.clone(),
            normal: hit.normal?.clone() ?? null,
            kind: hit.kind,
            targetId: hit.damageable?.id ?? null,
            objectName: hit.object.name,
          }
        : null,
      flightTimeSeconds: 0,
      verticalDropMetres: 0,
      lateralDriftMetres: 0,
    };
    if (!hit?.damageable) {
      return { shot, hit, damageApplied: 0, destroyed: false, report: null, trace };
    }

    const healthBefore = hit.damageable.health;
    const damage = hit.damageable.applyDamage({
      amount: shot.damage,
      point: hit.point,
      direction: shot.direction,
      sourceId: shot.sourceId,
      shotSequence: shot.sequence,
    });
    return {
      shot,
      hit,
      damageApplied: damage.applied,
      destroyed: damage.destroyed,
      report: {
        targetId: hit.damageable.id,
        objectName: hit.object.name,
        sourceId: shot.sourceId,
        shotSequence: shot.sequence,
        point: hit.point.clone(),
        normal: hit.normal?.clone() ?? null,
        rangeMetres: hit.distance,
        damageApplied: damage.applied,
        healthBefore,
        healthAfter: damage.health,
        destroyed: damage.destroyed,
      },
      trace,
    };
  }
}
