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
   * The fog SLAB, in absolute world metres: full density between base and top, fading
   * exponentially outside both over `groundScale` metres.
   *
   * ABSOLUTE, not relative to the terrain under you — that is the whole point. Fog
   * settles to a height, so it fills hollows and leaves ridges clear, and a player
   * dropping into a gully genuinely disappears into it.
   *
   * A base BELOW the terrain's own minimum gives ordinary ground fog, which is what most
   * presets want. Raising it above the valley floor lifts the slab off the ground into a
   * band — a valley inversion or a stratus deck lying against the hillsides, clear
   * underneath and clear above. That is the commoner sight in real terrain, and it does
   * something no ground layer can: it cuts sightlines at ONE altitude, so a ridge that
   * was a firing position is blind while the valley below it stays open.
   */
  groundBase: number;
  groundTop: number;
  /** Metres over which density falls by 1/e outside the slab. The layer's softness. */
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
    groundBase: NodeArg;
    groundTop: NodeArg;
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
  /**
   * The same layer, applied to the SKY.
   *
   * Standing inside ground fog and seeing clear sky above it is the tell that the fog is
   * painted on the terrain rather than filling the air: the ray to the sky crosses the
   * layer too. It carries a finite amount of fog looking straight up — the layer has a
   * top — and an unbounded amount along the horizon, which is why a fogged horizon goes
   * opaque and hides the seam where terrain would otherwise end against open sky.
   *
   * `direction` is the outward view ray; three renders the background on a sphere and
   * offers `normalWorldGeometry` for exactly this.
   */
  applySky: (rgb: NodeArg, direction: NodeArg) => NodeArg;
  set: (settings: FogSettings) => void;
}

export function createFog(settings: FogSettings): Fog {
  const uColor = uniform(new THREE.Color(settings.color));
  const uNear = uniform(settings.near);
  const uFar = uniform(settings.far);
  const uBase = uniform(settings.groundBase);
  const uTop = uniform(settings.groundTop);
  const uScale = uniform(Math.max(0.5, settings.groundScale));
  const uDensity = uniform(settings.groundDensity);
  const uNoiseScale = uniform(settings.groundNoiseScale);
  const uNoiseAmount = uniform(settings.groundNoiseAmount);
  const uDrift = uniform(settings.groundDrift);

  const apply = (rgb: NodeArg, worldPos: NodeArg): NodeArg => {
    // Planar view depth, matching three's own linear fog, so anything still using the
    // automatic path agrees with anything using this one.
    const viewZ = cameraViewMatrix.mul(vec4(worldPos, 1)).z.negate();
    // ORDERED, because the panel can drag near past far and a descending pair is left
    // INDETERMINATE by both the GLSL ES and WGSL specs — it happens to give the intended
    // ramp on drivers using the naive formula and can clamp to a constant on drivers that
    // assume e0 < e1. The same trap is already recorded against the grass fade.
    const distance = viewZ.smoothstep(uNear.min(uFar), uNear.max(uFar));

    // Ground layer, INTEGRATED ALONG THE VIEW RAY rather than evaluated at the point.
    //
    // Sampling the endpoint's own height was the obvious thing and it draws a hard line
    // across the terrain: ground a metre below the level is fully fogged and a metre
    // above it is not, so the layer's edge appears as a contour traced on the hillside
    // rather than as air. What matters is how much fog the ray PASSED THROUGH, which
    // varies continuously even where the surface height jumps.
    //
    // The profile is uniform below the level and falls off exponentially above it — a
    // well-mixed layer under an inversion — which is what keeps `density` meaning
    // extinction per metre wherever the camera stands.
    //
    // INTEGRATED THROUGH AN ANTIDERIVATIVE, and that detail is load-bearing rather than
    // elegant. Written as `exp(-camHeight) * (1 - exp(-dy))`, which is the same quantity
    // factored differently, the two terms overflow and underflow together: at a softness
    // of 1 m a point 100 m below the eye asks for exp(100), which is infinity in float32,
    // times exp(-100), which is zero — and infinity times zero is NaN. That NaN reached
    // the frame as a flat grey wall with a razor edge, which reads exactly like a fog bug
    // and is not one. In this form every exponent is negative by construction, so the
    // largest intermediate is 1.
    //
    //   F(y) = min(y, level) - scale * exp(-(max(y, level) - level) / scale)
    //
    // differentiates to the profile, so the optical depth over the ray is the difference
    // of F at its ends, scaled by how much path each metre of height buys.
    // Ordered, so dragging base past top in the panel folds the slab to nothing rather
    // than inverting it into negative optical depth.
    const base = uBase.min(uTop);
    const top = uBase.max(uTop);
    const scale = uScale;
    // F differentiates to the profile: an exponential tail below the base, full density
    // through the slab, an exponential tail above the top. Every exponent is clamped
    // NEGATIVE, which is the whole reason this is written as an antiderivative — the
    // factored form overflows to a NaN wall at small softness values.
    const antiderivative = (y: NodeArg): NodeArg =>
      scale
        .mul(base.sub(y).max(float(0)).div(scale).negate().exp())
        .add(y.clamp(base, top).sub(base))
        .add(scale.mul(y.sub(top).max(float(0)).div(scale).negate().exp().oneMinus()));
    const dy = worldPos.y.sub(cameraPosition.y);
    // Metres of path per metre of height. A level ray buys infinite path per metre, which
    // is the case the limit below covers.
    const perHeight = viewZ.div(dy.abs().max(float(1e-4)));
    const integral = antiderivative(worldPos.y).sub(antiderivative(cameraPosition.y)).abs();
    // The limit for a near-level ray: the density at the eye's own height over the whole
    // path, which is what the integral tends to and what the division cannot express.
    const profileAtEye = cameraPosition.y
      .sub(top)
      .max(base.sub(cameraPosition.y))
      .max(float(0))
      .div(scale)
      .negate()
      .exp();
    const throughLayer = dy
      .abs()
      .lessThan(float(1e-3))
      .select(viewZ.mul(profileAtEye), perHeight.mul(integral));

    const drift = time.mul(uDrift);
    const noise = mx_noise_float(
      V3(worldPos.x.mul(uNoiseScale).add(drift), worldPos.z.mul(uNoiseScale), drift.mul(0.6))
    );
    const modulated = noise.mul(uNoiseAmount).add(1).max(float(0));
    const optical = uDensity.mul(throughLayer).mul(modulated).max(float(0));
    const ground = optical.negate().exp().oneMinus();

    // Combined as two independent extinctions rather than added, so heavy ground fog at
    // range cannot push the total past opaque and clip.
    const total: NodeArg = distance.oneMinus().mul(ground.oneMinus()).oneMinus().clamp(0, 1);
    // Interpolant is the receiver — `t.mix(a, b)` is `mix(a, b, t)`, the reordering
    // catalogued in docs/08 §11 that has cost this project a pale wash once already.
    return total.mix(rgb, uColor);
  };

  // Shared with `apply`, and the reason the profile is written as an antiderivative:
  // the sky's ray runs to infinity, where F tends to the level itself, so the whole
  // column above the eye has a closed form rather than needing a far point invented for
  // it. Below the level that column grows as you sink into the layer; above it, it decays.
  const columnAbove = (): NodeArg => {
    const base = uBase.min(uTop);
    const top = uBase.max(uTop);
    const F = (y: NodeArg): NodeArg =>
      uScale
        .mul(base.sub(y).max(float(0)).div(uScale).negate().exp())
        .add(y.clamp(base, top).sub(base))
        .add(uScale.mul(y.sub(top).max(float(0)).div(uScale).negate().exp().oneMinus()));
    // F at infinity: both tails saturate, so the whole air column is the slab's own
    // thickness plus one softness length at each end. Finite, which is why looking
    // straight up out of a fog bank is hazy rather than opaque.
    const atInfinity = uScale.mul(2).add(top.sub(base));
    return atInfinity.sub(F(cameraPosition.y)).max(float(0));
  };

  const applySky = (rgb: NodeArg, direction: NodeArg): NodeArg => {
    // Path length through the layer for a ray leaving at this pitch. Looking level, the
    // divisor vanishes and the optical depth runs away — which is correct, and is what
    // closes the horizon.
    //
    // The LINEAR distance term is deliberately not applied here. At infinity it saturates,
    // so including it would flood the entire sky with fog colour on every preset; the
    // skybox already meets the terrain because each preset's fog colour was sampled from
    // that sky's own horizon band.
    const optical = uDensity.mul(columnAbove()).div(direction.y.max(float(1e-3)));
    const amount: NodeArg = optical.negate().exp().oneMinus().clamp(0, 1);
    return amount.mix(rgb, uColor);
  };

  return {
    uniforms: {
      color: uColor,
      near: uNear,
      far: uFar,
      groundBase: uBase,
      groundTop: uTop,
      groundScale: uScale,
      groundDensity: uDensity,
    },
    apply,
    applySky,
    set: (next) => {
      uColor.value.set(next.color);
      uNear.value = next.near;
      uFar.value = next.far;
      uBase.value = next.groundBase;
      uTop.value = next.groundTop;
      uScale.value = Math.max(0.5, next.groundScale);
      uDensity.value = next.groundDensity;
      uNoiseScale.value = next.groundNoiseScale;
      uNoiseAmount.value = next.groundNoiseAmount;
      uDrift.value = next.groundDrift;
    },
  };
}
