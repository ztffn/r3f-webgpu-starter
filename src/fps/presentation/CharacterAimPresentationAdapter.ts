import * as THREE from "three/webgpu";
import type { AuthoritativeAimState } from "../core/AuthoritativeAimState";

export interface AimRigRenderInput {
  /** Radians in character-render-root local space, normalized to [-PI, PI]. */
  yaw: number;
  /** Radians; positive pitch looks upward. */
  pitch: number;
  weight: number;
}

export type AuthoredForwardAxis = "+Z" | "-Z";

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export function normalizeYaw(yaw: number): number {
  return THREE.MathUtils.euclideanModulo(yaw + Math.PI, Math.PI * 2) - Math.PI;
}

/**
 * Sole gameplay-to-render conversion point for local, bot, and future network
 * aim. The frame uses world up, so character root roll on a slope does not tilt
 * the aim horizon. Positive yaw turns toward the root's right; pitch is up.
 */
export class CharacterAimPresentationAdapter {
  readonly output: AimRigRenderInput = { yaw: 0, pitch: 0, weight: 0 };

  private readonly authoredForward = new THREE.Vector3();
  private readonly rootForward = new THREE.Vector3();
  private readonly rootRight = new THREE.Vector3();
  private readonly horizontalAim = new THREE.Vector3();

  constructor(authoredForwardAxis: AuthoredForwardAxis = "+Z") {
    this.authoredForward.set(0, 0, authoredForwardAxis === "+Z" ? 1 : -1);
  }

  update(
    authoritative: AuthoritativeAimState,
    rootWorldQuaternion: THREE.Quaternion,
    weight: number
  ): AimRigRenderInput {
    this.rootForward.copy(this.authoredForward).applyQuaternion(rootWorldQuaternion);
    this.rootForward.y = 0;
    if (this.rootForward.lengthSq() < Number.EPSILON) this.rootForward.copy(this.authoredForward);
    this.rootForward.normalize();

    this.rootRight.crossVectors(WORLD_UP, this.rootForward).normalize();
    this.horizontalAim.copy(authoritative.direction);
    this.horizontalAim.y = 0;
    if (this.horizontalAim.lengthSq() < Number.EPSILON) this.horizontalAim.copy(this.rootForward);
    else this.horizontalAim.normalize();

    this.output.yaw = normalizeYaw(
      Math.atan2(
        this.horizontalAim.dot(this.rootRight),
        this.horizontalAim.dot(this.rootForward)
      )
    );
    this.output.pitch = Math.asin(THREE.MathUtils.clamp(authoritative.direction.y, -1, 1));
    this.output.weight = THREE.MathUtils.clamp(weight, 0, 1);
    return this.output;
  }
}
