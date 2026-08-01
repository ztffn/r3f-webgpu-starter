import type { BallisticEnvironment } from "./BallisticEnvironment";

export interface MutableVelocity {
  x: number;
  y: number;
  z: number;
}

// Calibrated so BC 0.505 loses velocity at about 0.0008 / metre, matching the
// prototype 175 gr profile through its published 500-yard velocity table.
export const DEFAULT_G1_REFERENCE_DRAG_PER_METRE = 0.000404;

/** Shared allocation-free velocity step for live projectiles and sight zeroing. */
export function integrateBallisticVelocity(
  velocityX: number,
  velocityY: number,
  velocityZ: number,
  ballisticCoefficientG1: number,
  environment: BallisticEnvironment,
  dtSeconds: number,
  target: MutableVelocity,
  referenceG1DragPerMetre = DEFAULT_G1_REFERENCE_DRAG_PER_METRE
): void {
  const relativeX = velocityX - environment.windVelocity.x;
  const relativeY = velocityY - environment.windVelocity.y;
  const relativeZ = velocityZ - environment.windVelocity.z;
  const relativeSpeed = Math.hypot(relativeX, relativeY, relativeZ);
  const dragPerMetre = referenceG1DragPerMetre / ballisticCoefficientG1;
  const dragAcceleration = dragPerMetre * relativeSpeed * relativeSpeed;
  const invRelativeSpeed = relativeSpeed > Number.EPSILON ? 1 / relativeSpeed : 0;
  target.x =
    velocityX +
    (environment.gravity.x - dragAcceleration * relativeX * invRelativeSpeed) * dtSeconds;
  target.y =
    velocityY +
    (environment.gravity.y - dragAcceleration * relativeY * invRelativeSpeed) * dtSeconds;
  target.z =
    velocityZ +
    (environment.gravity.z - dragAcceleration * relativeZ * invRelativeSpeed) * dtSeconds;
}
