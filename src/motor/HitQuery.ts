// Ray queries against the character motor's own physical representation.
//
// The server side of "who did that shot hit". Three-free and Rapier-free by the
// same rule as the rest of src/motor/, so the authority can resolve a shot in Node
// without the render-side WorldQuery, which is bound to Three and therefore
// browser-only. Pure functions over MotorState — no simulation, no allocation per
// query beyond the result.

import type { MotorHeightSource } from "./MotorTypes.ts";

/**
 * Distance along a ray to a capsule standing on `feet`, or null for a miss.
 *
 * THE CAPSULE IS THE HITBOX, deliberately, and it is the same capsule the motor
 * collides with — never a bone read (docs/10 §10), and never a Rapier body. Its
 * dimensions come from the blended stance, so a player caught mid-crouch is the
 * size the simulation says they are rather than the size of either endpoint.
 *
 * Solved as an infinite-cylinder test bounded by the segment, plus a sphere test at
 * each cap. The cheap version — a sphere at the body centre — is what makes prone
 * players unhittable at range and standing players hittable through their own feet.
 */
export function capsuleRayDistance(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  feetX: number,
  feetY: number,
  feetZ: number,
  radius: number,
  height: number
): number | null {
  // The capsule's spine runs between the two cap centres, one radius in from each
  // end. A body shorter than its own diameter degenerates to a single sphere.
  const spine = Math.max(0, height - radius * 2);
  const baseY = feetY + radius;
  const topY = baseY + spine;

  // Horizontal-only cylinder test: the spine is vertical, so the cylinder problem
  // collapses to a 2D circle in X/Z and stays a two-term quadratic.
  const ox = originX - feetX;
  const oz = originZ - feetZ;
  const a = dirX * dirX + dirZ * dirZ;
  let best: number | null = null;

  if (a > 1e-12) {
    const b = ox * dirX + oz * dirZ;
    const c = ox * ox + oz * oz - radius * radius;
    const discriminant = b * b - a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const nearT = (-b - root) / a;
      const farT = (-b + root) / a;
      if (nearT >= 0) {
        const y = originY + dirY * nearT;
        if (y >= baseY && y <= topY && (best === null || nearT < best)) best = nearT;
      }
      if (farT >= 0) {
        const y = originY + dirY * farT;
        if (y >= baseY && y <= topY && (best === null || farT < best)) best = farT;
      }
    }
  }

  // Caps. Needed even when the cylinder hit, because a ray entering through a cap
  // can reach it before the cylinder's own entry point. Unrolled — this is the
  // innermost loop of every server raycast and must not allocate.
  best = capRayBest(ox, originY - baseY, oz, dirX, dirY, dirZ, radius, best);
  if (spine > 0) best = capRayBest(ox, originY - topY, oz, dirX, dirY, dirZ, radius, best);
  return best;
}

/**
 * Distance along the ray where it LEAVES the capsule — the FARTHEST valid
 * intersection, under the same validity rules as the entry test. Only worth
 * calling for a capsule the ray is known to hit.
 */
export function capsuleRayExitDistance(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  feetX: number,
  feetY: number,
  feetZ: number,
  radius: number,
  height: number
): number | null {
  const spine = Math.max(0, height - radius * 2);
  const baseY = feetY + radius;
  const topY = baseY + spine;
  const ox = originX - feetX;
  const oz = originZ - feetZ;
  const a = dirX * dirX + dirZ * dirZ;
  let farthest: number | null = null;

  if (a > 1e-12) {
    const b = ox * dirX + oz * dirZ;
    const c = ox * ox + oz * oz - radius * radius;
    const discriminant = b * b - a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const farT = (-b + root) / a;
      if (farT >= 0) {
        const y = originY + dirY * farT;
        if (y >= baseY && y <= topY && (farthest === null || farT > farthest)) farthest = farT;
      }
    }
  }
  farthest = capRayFarthest(ox, originY - baseY, oz, dirX, dirY, dirZ, radius, farthest);
  if (spine > 0) {
    farthest = capRayFarthest(ox, originY - topY, oz, dirX, dirY, dirZ, radius, farthest);
  }
  return farthest;
}

/** Farthest non-negative ray-sphere root for one cap, folded into `farthest`. */
function capRayFarthest(
  ox: number,
  oy: number,
  oz: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  radius: number,
  farthest: number | null
): number | null {
  const b = ox * dirX + oy * dirY + oz * dirZ;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return farthest;
  const farT = -b + Math.sqrt(discriminant);
  if (farT >= 0 && (farthest === null || farT > farthest)) farthest = farT;
  return farthest;
}

/** Nearest non-negative ray-sphere root for one cap, folded into `best`. */
function capRayBest(
  ox: number,
  oy: number,
  oz: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  radius: number,
  best: number | null
): number | null {
  const b = ox * dirX + oy * dirY + oz * dirZ;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return best;
  const root = Math.sqrt(discriminant);
  const nearT = -b - root;
  const farT = -b + root;
  if (nearT >= 0 && (best === null || nearT < best)) best = nearT;
  if (farT >= 0 && (best === null || farT < best)) best = farT;
  return best;
}

/**
 * First distance along the ray at which it is under the terrain, or null.
 *
 * A fixed march then a bisection, NOT the render-side query: `CompositeWorldQuery`
 * resolves the same bilinear surface but imports Three, so it cannot run here. The
 * two agree because they read the same height source — that shared field is the
 * whole point (docs/04 §2).
 *
 * The step is in CELLS rather than metres so it scales with the map's own
 * resolution, and it is under a cell so the march cannot straddle a ridge and miss
 * it. A ray that starts underground reports 0 rather than marching out of the
 * ground and calling the far side a hit.
 */
export function terrainRayDistance(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDistance: number,
  heights: MotorHeightSource,
  stepCells = 0.5
): number | null {
  const step = Math.max(0.25, heights.cellSize * stepCells);
  if (originY <= heights.sample(originX, originZ)) return 0;

  let previous = 0;
  for (let t = step; t <= maxDistance; t += step) {
    const y = originY + dirY * t;
    if (y > heights.sample(originX + dirX * t, originZ + dirZ * t)) {
      previous = t;
      continue;
    }
    // Bracketed between `previous` (above) and `t` (below). Eight halvings takes a
    // 0.5-cell bracket to a couple of millimetres, which is far below the 0.031 m
    // the two collision representations already disagree by (docs/12 §7).
    let low = previous;
    let high = t;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const mid = (low + high) * 0.5;
      const midY = originY + dirY * mid;
      if (midY > heights.sample(originX + dirX * mid, originZ + dirZ * mid)) low = mid;
      else high = mid;
    }
    return high;
  }
  return null;
}

/**
 * Surface normal of a capsule at a hit point, written into `out`.
 *
 * Radial from the nearest point on the spine: on the cylinder wall that is a
 * horizontal push-out, on a cap it tilts toward the pole. The ballistic model
 * feeds this to the incidence term, so a grazing round through the shoulder
 * meets more flesh than a square hit — same rule as every other surface.
 */
export function capsuleNormalAt(
  pointX: number,
  pointY: number,
  pointZ: number,
  feetX: number,
  feetY: number,
  feetZ: number,
  radius: number,
  height: number,
  out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
): { x: number; y: number; z: number } {
  const spine = Math.max(0, height - radius * 2);
  const baseY = feetY + radius;
  const topY = baseY + spine;
  const spineY = pointY < baseY ? baseY : pointY > topY ? topY : pointY;
  const dx = pointX - feetX;
  const dy = pointY - spineY;
  const dz = pointZ - feetZ;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9) {
    out.x = 0;
    out.y = 1;
    out.z = 0;
    return out;
  }
  out.x = dx / length;
  out.y = dy / length;
  out.z = dz / length;
  return out;
}

/**
 * Terrain surface normal from central differences of the shared height source,
 * written into `out`. Half-cell step: wide enough to smooth sampling noise,
 * narrow enough that a one-cell ridge still reads as its own slope.
 */
export function terrainNormalAt(
  heights: MotorHeightSource,
  x: number,
  z: number,
  out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
): { x: number; y: number; z: number } {
  const step = Math.max(1e-3, heights.cellSize * 0.5);
  const slopeX = (heights.sample(x + step, z) - heights.sample(x - step, z)) / (2 * step);
  const slopeZ = (heights.sample(x, z + step) - heights.sample(x, z - step)) / (2 * step);
  const length = Math.hypot(slopeX, 1, slopeZ);
  out.x = -slopeX / length;
  out.y = 1 / length;
  out.z = -slopeZ / length;
  return out;
}
