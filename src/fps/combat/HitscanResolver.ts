import type * as THREE from "three/webgpu";
import type { WorldHit, WorldQuery } from "../core/WorldQuery";

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
}

export class HitscanResolver {
  private readonly worldQuery: WorldQuery;

  constructor(worldQuery: WorldQuery) {
    this.worldQuery = worldQuery;
  }

  resolve(shot: HitscanShot): HitscanResult {
    const hit = this.worldQuery.raycast(shot.origin, shot.direction, shot.maxDistance);
    if (!hit?.damageable) {
      return { shot, hit, damageApplied: 0, destroyed: false };
    }

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
    };
  }
}
