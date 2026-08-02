// Atmosphere as one shared TSL term: linear distance fog plus a ground layer.
//
// Terrain and the relief march must apply the IDENTICAL expression or they fog apart at
// every horizon, which is why this is a module rather than two copies — the same seam
// the colour grade went through. Ground fog is height-based and pools in hollows, which
// is why it is here at all: a valley you can crawl along unseen is cover, not decoration.

import { cameraViewMatrix, float, mx_noise_float, time, uniform, vec3, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

const V3 = vec3 as unknown as (x: NodeArg, y: NodeArg, z: NodeArg) => NodeArg;

export interface FogSettings {
  color: string;
  near: number;
  far: number;
  /**
   * World height, metres, below which the ground layer is at full strength. Above
   * `groundTop` there is none, and it fades between the two.
   *
   * ABSOLUTE, not relative to the terrain under you — that is the whole point. Fog
   * settles to a level, so it fills hollows and leaves ridges clear, and a player
   * dropping into a gully genuinely disappears into it.
   */
  groundBase: number;
  groundTop: number;
  /** Extinction per metre travelled through the layer. 0 disables it entirely. */
  groundDensity: number;
  /** Metres per unit of the noise lattice that breaks up the layer's edge. */
  groundNoiseScale: number;
  /** How far the noise swings the density, either side of 1. */
  groundNoiseAmount: number;
  /** Lattice units per second the noise drifts. */
  groundDrift: number;
}

export interface Fog {
  uniforms: {
    color: NodeArg;
    near: NodeArg;
    far: NodeArg;
    groundBase: NodeArg;
    groundTop: NodeArg;
    groundDensity: NodeArg;
  };
  /**
   * Blend a colour toward the fog, given the world position it was sampled at.
   *
   * Takes a WORLD POSITION rather than a depth so both callers derive view depth the
   * same way. The march has a hit position hundreds of metres from the surface it
   * rasterised, so it cannot use the fragment's own depth, and terrain must then use the
   * same formula or the two disagree along every skyline.
   */
  apply: (rgb: NodeArg, worldPos: NodeArg) => NodeArg;
  set: (settings: FogSettings) => void;
}

export function createFog(settings: FogSettings): Fog {
  const uColor = uniform(new THREE.Color(settings.color));
  const uNear = uniform(settings.near);
  const uFar = uniform(settings.far);
  const uBase = uniform(settings.groundBase);
  const uTop = uniform(settings.groundTop);
  const uDensity = uniform(settings.groundDensity);
  const uNoiseScale = uniform(settings.groundNoiseScale);
  const uNoiseAmount = uniform(settings.groundNoiseAmount);
  const uDrift = uniform(settings.groundDrift);

  const apply = (rgb: NodeArg, worldPos: NodeArg): NodeArg => {
    // Planar view depth, matching three's own linear fog, so anything still using the
    // automatic path agrees with anything using this one.
    const viewZ = cameraViewMatrix.mul(vec4(worldPos, 1)).z.negate();
    const distance = viewZ.smoothstep(uNear, uFar);

    // Ground layer. Height gives the fraction of the layer this point sits inside —
    // 1 below the base, 0 above the top — and the extinction integrates that over the
    // distance travelled, so a distant point low in a valley fogs far more than a near
    // one at the same height. `exp` rather than a ramp because that is what extinction
    // through a medium actually does, and it never quite reaches opaque.
    const height = worldPos.y.smoothstep(uTop, uBase);
    const drift = time.mul(uDrift);
    const noise = mx_noise_float(
      V3(worldPos.x.mul(uNoiseScale).add(drift), worldPos.z.mul(uNoiseScale), drift.mul(0.6))
    );
    const modulated = noise.mul(uNoiseAmount).add(1).max(float(0));
    const ground = uDensity
      .mul(viewZ)
      .mul(height)
      .mul(modulated)
      .negate()
      .exp()
      .oneMinus();

    // Combined as two independent extinctions rather than added, so heavy ground fog at
    // range cannot push the total past opaque and clip.
    const total: NodeArg = distance.oneMinus().mul(ground.oneMinus()).oneMinus().clamp(0, 1);
    // Interpolant is the receiver — `t.mix(a, b)` is `mix(a, b, t)`, the reordering
    // catalogued in docs/08 §11 that has cost this project a pale wash once already.
    return total.mix(rgb, uColor);
  };

  return {
    uniforms: {
      color: uColor,
      near: uNear,
      far: uFar,
      groundBase: uBase,
      groundTop: uTop,
      groundDensity: uDensity,
    },
    apply,
    set: (next) => {
      uColor.value.set(next.color);
      uNear.value = next.near;
      uFar.value = next.far;
      uBase.value = next.groundBase;
      uTop.value = next.groundTop;
      uDensity.value = next.groundDensity;
      uNoiseScale.value = next.groundNoiseScale;
      uNoiseAmount.value = next.groundNoiseAmount;
      uDrift.value = next.groundDrift;
    },
  };
}
