// Atmosphere as one shared TSL term: linear distance fog plus a ground layer.
//
// Terrain and the relief march must apply the IDENTICAL expression or they fog apart at
// every horizon, which is why this is a module rather than two copies — the same seam
// the colour grade went through. Ground fog is height-based and pools in hollows, which
// is why it is here at all: a valley you can crawl along unseen is cover, not decoration.

import {
  cameraPosition,
  cameraViewMatrix,
  float,
  mx_noise_float,
  time,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

const V3 = vec3 as unknown as (x: NodeArg, y: NodeArg, z: NodeArg) => NodeArg;

export interface FogSettings {
  color: string;
  near: number;
  far: number;
  /**
   * World height, metres, where the ground layer is thickest. Density falls off
   * exponentially above it over `groundScale` metres.
   *
   * ABSOLUTE, not relative to the terrain under you — that is the whole point. Fog
   * settles to a level, so it fills hollows and leaves ridges clear, and a player
   * dropping into a gully genuinely disappears into it.
   */
  groundLevel: number;
  /** Metres over which density falls by 1/e above the level. The layer's softness. */
  groundScale: number;
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
    groundLevel: NodeArg;
    groundScale: NodeArg;
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
  const uLevel = uniform(settings.groundLevel);
  const uScale = uniform(Math.max(0.5, settings.groundScale));
  const uDensity = uniform(settings.groundDensity);
  const uNoiseScale = uniform(settings.groundNoiseScale);
  const uNoiseAmount = uniform(settings.groundNoiseAmount);
  const uDrift = uniform(settings.groundDrift);

  const apply = (rgb: NodeArg, worldPos: NodeArg): NodeArg => {
    // Planar view depth, matching three's own linear fog, so anything still using the
    // automatic path agrees with anything using this one.
    const viewZ = cameraViewMatrix.mul(vec4(worldPos, 1)).z.negate();
    const distance = viewZ.smoothstep(uNear, uFar);

    // Ground layer, INTEGRATED ALONG THE VIEW RAY rather than evaluated at the point.
    //
    // Sampling the endpoint's own height was the obvious thing and it draws a hard line
    // across the terrain: ground a metre below the level is fully fogged and a metre
    // above it is not, so the layer's edge appears as a contour traced on the hillside
    // rather than as air. What matters is how much fog the ray PASSED THROUGH, which
    // varies continuously even where the surface height jumps — a point just above the
    // level still fogs, because the ray reaching it crossed the layer to get there.
    //
    // Density falls exponentially with height, `D * exp(-(y - level) / scale)`, so there
    // is no top at all to cut off against. Its integral along a ray has a closed form:
    //
    //   fog = D * scale / dirY * exp(-(yCam - level)/scale) * (1 - exp(-dist * dirY / scale))
    //
    // and the awkward case is a level ray, where dirY is 0 and both the division and the
    // bracket vanish together. `(1 - exp(-x)) / x` tends to 1 there, so substituting that
    // limit gives `D * dist * exp(...)`, which is just uniform density over the path.
    const dy = worldPos.y.sub(cameraPosition.y);
    const heightFall = cameraPosition.y.sub(uLevel).div(uScale).negate().exp();
    const x = dy.div(uScale);
    // The limit form, guarded: `expm1(-x)/-x` is 1 at x = 0 and TSL has no expm1, so the
    // series is used inside a hair of zero where the direct form loses all its bits.
    const tiny = x.abs().lessThan(float(1e-3));
    const pathFactor = tiny.select(
      float(1).sub(x.mul(0.5)),
      x.negate().exp().oneMinus().div(x.add(float(1e-9)))
    );
    const drift = time.mul(uDrift);
    const noise = mx_noise_float(
      V3(worldPos.x.mul(uNoiseScale).add(drift), worldPos.z.mul(uNoiseScale), drift.mul(0.6))
    );
    const modulated = noise.mul(uNoiseAmount).add(1).max(float(0));
    const optical = uDensity
      .mul(viewZ)
      .mul(heightFall)
      .mul(pathFactor)
      .mul(modulated)
      .max(float(0));
    const ground = optical.negate().exp().oneMinus();

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
      groundLevel: uLevel,
      groundScale: uScale,
      groundDensity: uDensity,
    },
    apply,
    set: (next) => {
      uColor.value.set(next.color);
      uNear.value = next.near;
      uFar.value = next.far;
      uLevel.value = next.groundLevel;
      uScale.value = Math.max(0.5, next.groundScale);
      uDensity.value = next.groundDensity;
      uNoiseScale.value = next.groundNoiseScale;
      uNoiseAmount.value = next.groundNoiseAmount;
      uDrift.value = next.groundDrift;
    },
  };
}
