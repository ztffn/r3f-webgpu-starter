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
  private readonly roots: THREE.Object3D[] = [];
  private readonly ownerByRoot = new Map<THREE.Object3D, WorldQueryRegistration>();

  constructor(layer = 0) {
    this.raycaster.layers.set(layer);
  }

  register(registration: WorldQueryRegistration): () => void {
    this.registrations.add(registration);
    this.roots.push(registration.root);
    this.ownerByRoot.set(registration.root, registration);
    return () => {
      if (!this.registrations.delete(registration)) return;
      this.ownerByRoot.delete(registration.root);
      const index = this.roots.indexOf(registration.root);
      if (index >= 0) this.roots.splice(index, 1);
    };
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

    const nearest = this.raycaster.intersectObjects(this.roots, true)[0];
    if (!nearest) return null;
    let owner: WorldQueryRegistration | undefined;
    let candidate: THREE.Object3D | null = nearest.object;
    while (candidate && !owner) {
      owner = this.ownerByRoot.get(candidate);
      candidate = candidate.parent;
    }
    if (!owner) return null;

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
