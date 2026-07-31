import * as THREE from "three/webgpu";
import type { Damageable } from "../combat/Damageable";

export type WorldHitKind = "terrain" | "target" | "world";

export interface WorldHit {
  readonly distance: number;
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3 | null;
  readonly kind: WorldHitKind;
  readonly damageable: Damageable | null;
  readonly object: THREE.Object3D;
}

export interface WorldQuery {
  raycast(origin: THREE.Vector3Like, direction: THREE.Vector3Like, maxDistance: number): WorldHit | null;
}

export interface WorldQueryRegistration {
  readonly root: THREE.Object3D;
  readonly kind: WorldHitKind;
  readonly damageable?: Damageable;
}

/** Three.js adapter over explicitly registered gameplay-query roots. */
export class ThreeWorldQuery implements WorldQuery {
  private readonly raycaster = new THREE.Raycaster();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly registrations = new Set<WorldQueryRegistration>();

  constructor(layer = 0) {
    this.raycaster.layers.set(layer);
  }

  register(registration: WorldQueryRegistration): () => void {
    this.registrations.add(registration);
    return () => this.registrations.delete(registration);
  }

  raycast(origin: THREE.Vector3Like, direction: THREE.Vector3Like, maxDistance: number): WorldHit | null {
    if (!(maxDistance > 0)) return null;
    this.direction.set(direction.x, direction.y, direction.z);
    if (this.direction.lengthSq() < Number.EPSILON) return null;
    this.direction.normalize();
    this.raycaster.near = 0;
    this.raycaster.far = maxDistance;
    this.origin.set(origin.x, origin.y, origin.z);
    this.raycaster.set(this.origin, this.direction);

    let nearest: THREE.Intersection | null = null;
    let owner: WorldQueryRegistration | null = null;
    for (const registration of this.registrations) {
      const hit = this.raycaster.intersectObject(registration.root, true)[0];
      if (hit && (!nearest || hit.distance < nearest.distance)) {
        nearest = hit;
        owner = registration;
      }
    }
    if (!nearest || !owner) return null;

    return {
      distance: nearest.distance,
      point: nearest.point.clone(),
      normal: nearest.face?.normal.clone().transformDirection(nearest.object.matrixWorld) ?? null,
      kind: owner.kind,
      damageable: owner.damageable ?? null,
      object: nearest.object,
    };
  }
}
