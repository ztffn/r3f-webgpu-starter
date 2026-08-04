// Minimal vector and scalar helpers for the shared ballistic core.
//
// src/combat/ runs in the browser and in Node (docs/12 §3), so this module is
// the combat-side replacement for the handful of THREE.MathUtils and Vector3
// operations the ballistic code used: a plain {x,y,z} shape plus clamp/lerp.

/** Plain vector shape. THREE.Vector3 satisfies it structurally. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Mutable variant for scratch registers and out-parameters. */
export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}
