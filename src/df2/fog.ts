// Atmosphere as one shared TSL term: linear distance fog plus a ground layer.
//
// Terrain and the relief march must apply the IDENTICAL expression or they fog apart at
// every horizon, which is why this is a module rather than two copies — the same seam
// the colour grade went through. Ground fog is height-based and pools in hollows, which
// is why it is here at all: a valley you can crawl along unseen is cover, not decoration.
//
// Fog COLOUR comes from the sky itself, sampled along the view ray, rather than from a
// constant — see `hazeAt` for why a constant cannot be made to work.

import {
  Fn,
  If,
  cameraPosition,
  cameraViewMatrix,
  cubeTexture,
  float,
  texture3D,
  time,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { luminance } from "./colorGrade";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

const V3 = vec3 as unknown as (x: NodeArg, y: NodeArg, z: NodeArg) => NodeArg;

/** Metres. One puff at birth, at the canister — small, because many will overlap. */
const SMOKE_START_RADIUS = 1.2;
const SMOKE_MAX_RADIUS = 7;
const SMOKE_GROW_SECONDS = 5;
/**
 * Seconds between puffs, and how long the canister burns.
 *
 * Together with the slot count these decide the plume: a puff must expire before its slot
 * is needed again, or the newest one stomps the oldest still-visible one and the plume
 * flickers at its tail. Slots x interval is the budget — 12 x 1.1 s here, against a puff
 * life of 11 s, which leaves one slot of headroom.
 */
const SMOKE_EMIT_SECONDS = 1.1;
const SMOKE_EMIT_SECONDS_TOTAL = 30;
/** Canisters burning at once. Beyond this the shared slot pool cannot feed them. */
const SMOKE_MAX_EMITTERS = 3;
/**
 * Extinction per metre at the centre — thick enough to break a sightline.
 *
 * Lowered as the radius grew, because the two multiply: optical depth is density times
 * the chord, so a wider puff at the same density is not just bigger but far more opaque.
 */
const SMOKE_DENSITY = 0.22;
/** Long enough to cross a road under, which is the only reason to throw one. */
const SMOKE_LIFE_SECONDS = 11;
/** Metres per second the column climbs at first, decaying as it mixes. */
const SMOKE_RISE = 1.6;
/**
 * How much of the wind a puff takes. Not 1: a smoke column is denser than air and drags
 * on the ground, so it leans downwind rather than travelling with it — which is what lets
 * a screen hold position long enough to be worth throwing.
 */
const SMOKE_WIND_SHARE = 0.45;
/**
 * WRAPS PER METRE, which is not what it meant before the shared noise texture landed.
 *
 * Sampling a 3D texture wraps at 1.0, so this value IS the reciprocal of the tiling
 * distance: at 0.07 the texture repeats every 14 m and its coarsest channel — four cells
 * across — gives lumps of about 3.5 m. The old 0.35 was carried over from computed
 * gradient noise, where the number meant lattice units per metre, and it put 0.7 m lumps
 * on a 13 m puff.
 *
 * That fineness is also what made walking out of a puff feel like a dolly zoom: a single
 * noise sample per ray is inherently view-dependent, and the finer the lattice the more
 * violently the pattern slides as the sample point travels along the ray. Coarse features
 * move slowly enough to read as the medium rather than as a lens.
 */
const SMOKE_NOISE_SCALE = 0.07;
/** Lattice units per second — smoke boils slowly, and fast reads as fire. */
const SMOKE_CHURN = 0.12;
/** How far the noise pushes the silhouette in or out, as a fraction of the radius. */
const SMOKE_LUMPINESS = 0.22;
/** How far it swings the density inside. */
const SMOKE_MOTTLE = 0.45;

export interface FogSettings {
  /** The shared tiling noise (noiseTexture.ts) — one fetch instead of gradient noise. */
  noise: THREE.Data3DTexture;
  /** Horizontal wind, m/s. Smoke leans on it — the same vector that drifts bullets. */
  wind: { x: number; z: number };
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

/**
 * How many puffs can exist at once. Unrolled in the graph, so it is baked at build.
 *
 * A grenade is not one of these — it is an EMITTER that fills several. A single volume
 * that drifts downwind takes the whole cloud with it and leaves the canister smoking
 * nothing, which is exactly backwards: the source stays put and the plume streams off it.
 * So the slot count sets how long a plume can be, not how many grenades there are.
 */
const SMOKE_SLOTS = 12;

export interface Fog {
  /**
   * Drop a smoke volume at a world position. Reuses the oldest slot when full.
   *
   * Cheap for the same reason the fog layer is: the medium is a function of position with
   * a closed-form line integral, so a puff costs a few arithmetic operations per fragment
   * rather than a raymarch. Optical depths ADD, so smoke and weather compose into one
   * exponential at the end with no blending order to get wrong.
   */
  spawnSmoke: (x: number, y: number, z: number, color?: string) => void;
  /** Grow and fade the live volumes. Call once a frame with the delta in seconds. */
  tickSmoke: (dt: number) => void;
  uniforms: {
    color: NodeArg;
    near: NodeArg;
    far: NodeArg;
    groundBase: NodeArg;
    groundTop: NodeArg;
    groundScale: NodeArg;
    groundDensity: NodeArg;
    /** How far the fog colour comes from the sky rather than from `color`. */
    skyAmount: NodeArg;
    /** How much of the sky's detail the haze keeps, 0 sharp to 1 flat. */
    skyBlur: NodeArg;
    /** How much haze drains colour before it adds the sky's. 0 is a pure cross-fade. */
    hazeDrain: NodeArg;
    /** Lowest sky elevation the haze samples, keeping it off the pack's baked ground. */
    hazeLift: NodeArg;
  };
  /**
   * Point the haze at a sky, or at nothing.
   *
   * IN PLACE, not a rebuild — see the node's own comment. `null` collapses the term to the
   * flat `color`, which is what presets with no cubemap want and is also the pre-cubemap
   * behaviour, so nothing regresses when a sky is missing or still loading.
   */
  setSky: (sky: THREE.CubeTexture | null) => void;
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

  // --- the sky, as the fog's colour ------------------------------------------
  //
  // ONE base node, sampled several ways. `.sample()` and `.level()` clone the node but
  // point the clone's `referenceNode` back here, and TextureNode's `value` accessor
  // forwards through that reference — so a preset switch assigns `.value` once and every
  // derived sample follows. Three rebuilds the bind group when a texture uniform comes to
  // refer to a different texture object, which is what lets the sky swap without
  // rebuilding the terrain material and losing its geometry cache.
  //
  // Starts empty: the fog is built before the cubemap has loaded, and `skyAmount` holds
  // the whole term at zero until `setSky` supplies one.
  const emptySky = new THREE.CubeTexture();
  const skyBase: NodeArg = cubeTexture(emptySky);
  /**
   * SEPARATE from the dial below, and they were briefly the same uniform.
   *
   * This is the fact "a cubemap is bound", owned by `setSky`; `skyAmount` is the number
   * a person is tuning. Sharing storage meant every preset button press slammed the dial
   * back to 1 and threw away whatever had been found — on the one dial whose whole
   * purpose is comparing presets against each other.
   */
  const uHasSky = uniform(0);
  const uSkyAmount = uniform(1);
  /**
   * 0 samples the sharp sky, 1 its smallest mip. Haze is the sky's LOW frequencies —
   * sampled sharp, the cubemap's clouds get stamped onto distant terrain.
   *
   * A FRACTION of the mip chain rather than a level, via `.blur()`, which scales it by
   * three's own `maxMipLevel`. That node re-reads the texture every frame, so it copes
   * with a cubemap whose faces are still downloading and with a pack at any resolution —
   * neither of which a level computed at build time from `image[0].width` can do.
   */
  const uSkyBlur = uniform(0.55);
  /**
   * How much haze DRAINS colour before it adds its own.
   *
   * A straight cross-fade to the sky says colour is lost and sky colour gained at exactly
   * the same rate, and air does not work that way: a ridge in the middle distance has gone
   * grey-blue long before it has gone sky-coloured. Draining toward luminance first
   * separates the two, so the same fog range can read as thin clear air that merely
   * desaturates, or as a wash that takes the sky's hue with it.
   *
   * 0 is the pure cross-fade — the behaviour before this dial existed, kept as the default
   * so nothing shifts under anyone who already liked what they had.
   */
  const uHazeDrain = uniform(0);
  /**
   * Lowest elevation the haze will sample the sky at, as sin(pitch).
   *
   * NOT COSMETIC. Distant terrain is below eye level, so its view ray points down, and a
   * skybox below the horizon holds whatever the pack baked under it — black, in this one,
   * because terrain was always going to cover it. Fading the far field toward that turned
   * everything past the fog range into a black wall under a pale sky.
   *
   * Lifted clear of the horizon rather than clamped flat onto it, because the haze samples
   * a blurred mip whose footprint spans several degrees: sitting exactly on the seam
   * averages the pack's baked ground back in through the blur. A pack with a graded lower
   * hemisphere wants this near 0; one with a hard painted floor wants it higher.
   */
  const uHazeLift = uniform(0.12);
  // Smoke: centre in xyz and current radius in w, with density held separately so a puff
  // can fade without shrinking. Separate uniforms rather than an array because the graph
  // unrolls them anyway at this count, and a scalar `.value` assignment is the one form
  // the WebGPU uniform path reliably re-uploads.
  const uSmoke = Array.from({ length: SMOKE_SLOTS }, () => uniform(new THREE.Vector4(0, 0, 0, 1)));
  const uSmokeDensity = Array.from({ length: SMOKE_SLOTS }, () => uniform(0));
  // PER PUFF, not the fog's colour. Signal smoke is colour-coded — purple, yellow, red,
  // white — and that is most of what makes it read as a grenade rather than as weather.
  const uSmokeColor = Array.from({ length: SMOKE_SLOTS }, () => uniform(new THREE.Color(1, 1, 1)));
  const smokeAge = new Array<number>(SMOKE_SLOTS).fill(Infinity);
  const smokeOrigin = Array.from({ length: SMOKE_SLOTS }, () => new THREE.Vector3());

  /** A canister on the ground, emitting puffs until it burns out. */
  interface Emitter {
    x: number;
    y: number;
    z: number;
    color: string;
    age: number;
    sinceEmit: number;
  }
  const emitters: Emitter[] = [];

  const emitPuff = (x: number, y: number, z: number, color: string): void => {
    let slot = 0;
    for (let i = 1; i < SMOKE_SLOTS; i++) if (smokeAge[i] > smokeAge[slot]) slot = i;
    smokeAge[slot] = 0;
    smokeOrigin[slot].set(x, y, z);
    uSmoke[slot].value.set(x, y, z, SMOKE_START_RADIUS);
    uSmokeDensity[slot].value = SMOKE_DENSITY;
    uSmokeColor[slot].value.set(color);
  };

  // Sampled with an EXPLICIT level 0: the coordinates come from world positions that can
  // jump metres between neighbouring pixels, and derivative-selected mips would pick one
  // near the top of the pyramid — the pale-wash trap this project already paid for.
  const noiseAt = (p: NodeArg): NodeArg => texture3D(settings.noise, p).level(float(0));
  const uNoiseScale = uniform(settings.groundNoiseScale);
  const uNoiseAmount = uniform(settings.groundNoiseAmount);
  let windX = settings.wind.x;
  let windZ = settings.wind.z;
  const uDrift = uniform(settings.groundDrift);

  /**
   * Optical depth added by the smoke volumes along a ray.
   *
   * The exact integral of a UNIFORM sphere is its chord, and the chord already falls to
   * zero at the rim — but with a vertical tangent, which reads as a hard ball. Weighting
   * it by the same quantity again approximates a quadratic density falloff and costs one
   * multiply, which is the whole difference between a bubble and smoke.
   *
   * `maxT` clips the integral at the surface behind it, so a puff correctly stops fogging
   * what is in front of it — that is what makes this compose with geometry rather than
   * float over it.
   */
  /**
   * GATED, and the gate is the whole difference between shippable and not.
   *
   * Written branchlessly first, this cost 5 ms a frame at dpr 2 — on every frame, with no
   * smoke anywhere, because a noise sample per slot runs for every fragment on screen and
   * a density of zero only zeroes the RESULT, never the work. That is the same shape of
   * mistake as an unmeasured overlay, and the same toggle discipline caught it.
   *
   * Inside a `Fn`, `If` gives the lanes somewhere to skip to. The test is two comparisons
   * against values already in hand: is this slot alive, and could its sphere possibly
   * touch this ray. Empty slots then cost two compares, and a live puff costs its noise
   * only across the pixels it actually covers.
   */
  const smokeDepth = Fn(([origin, dir, maxT]: NodeArg[]): NodeArg => {
    const drift = time.mul(SMOKE_CHURN);
    const total = float(0).toVar();
    const tint = V3(0, 0, 0).toVar();
    for (let i = 0; i < SMOKE_SLOTS; i++) {
      const centre = uSmoke[i];
      // NESTED, not `.and()`. A single combined test still EMITS everything it compares:
      // `&&` short-circuits the branch, not the statements already written above it. The
      // ray-sphere setup is ~20 operations, so twelve empty slots were paying ~240 per
      // fragment — which is the entire measured cost of going from four slots to twelve.
      // Behind the density test first, a dead slot costs one compare.
      If(uSmokeDensity[i].greaterThan(float(0)), () => {
      const m = centre.xyz.sub(origin);
      const b = dir.dot(m);
      const perpSq = m.dot(m).sub(b.mul(b));
      // Generous by the lumpiness margin, since the noise can push the silhouette out.
      const reach = centre.w.mul(1 + SMOKE_LUMPINESS);
      If(perpSq.lessThan(reach.mul(reach)), () => {
      // ONE noise sample, doing both jobs. It is taken at the ray's CLOSEST POINT to the
      // centre — a world position, not a screen or view quantity — so the lumps stay put
      // when the camera turns. Sampling per screen pixel instead is the classic way to
      // make smoke that crawls as you look around.
      //
      // Perturbing the radius breaks the circular silhouette, which is what gives a puff
      // away as a sphere; reusing the same sample on the density correlates the bulges
      // with the thick parts, which is how real smoke reads. Two jobs from one sample
      // because at four slots this is the most expensive thing in the term.
      const perp = origin.add(dir.mul(b));
      const s3 = noiseAt(perp.mul(SMOKE_NOISE_SCALE).add(drift));
      const n = s3.r.mul(0.6).add(s3.g.mul(0.4)).sub(0.5).mul(2);
      const radius = centre.w.mul(n.mul(SMOKE_LUMPINESS).add(1));

      const inside = radius.mul(radius).sub(perpSq).max(float(0));
      const half = inside.sqrt();
      const t0 = b.sub(half).clamp(float(0), maxT);
      const t1 = b.add(half).clamp(float(0), maxT);
      // No `max(0)`: clamp is monotone and `half` is non-negative, so t1 >= t0 always.
      const chord = t1.sub(t0);
      // SMOOTHSTEPPED rather than the raw quadratic. Both reach zero at the rim, but the
      // quadratic arrives with a slope, which the eye reads as an edge on something that
      // should have none. The S-curve is flat at both ends, so the puff fades out of
      // existence instead of stopping.
      const falloff = inside
        .div(radius.mul(radius).max(float(1e-4)))
        .smoothstep(float(0), float(1));
      const density = uSmokeDensity[i].mul(n.mul(SMOKE_MOTTLE).add(1).max(float(0)));
      const depth = density.mul(chord).mul(falloff);
      total.addAssign(depth);
      // Colour accumulated WEIGHTED BY DEPTH, so two overlapping puffs of different
      // colours blend by how much of each the ray crossed rather than by slot order.
      tint.addAssign((uSmokeColor[i] as NodeArg).mul(depth));
      });
      });
    }
    // Normalised back out of the weighting, guarded — a ray through no smoke has a zero
    // weight and would otherwise divide by it.
    const V4 = vec4 as unknown as (a: NodeArg, b: NodeArg) => NodeArg;
    return V4(tint.div(total.max(float(1e-5))), total);
  });

  /**
   * The colour distance fades TOWARD, for a ray leaving the eye in `dir`.
   *
   * A single fog colour cannot be made to work and the presets already said so: every one
   * of them carries a hand-picked `fogColor` that has to match its sky's horizon, which is
   * only satisfiable for a sky that looks the same in every direction. Under a red dawn or
   * a storm the constant is right facing one way and a bar of the wrong colour facing the
   * other — terrain fading pale under a dark ceiling, and a hilltop coming out BRIGHTER
   * than the sky directly behind it, which never happens in air and reads as fake at once.
   *
   * Sampling the sky in the view direction removes the whole class of problem: terrain
   * fades toward exactly what is behind it, so it can never outshine it. Sun inscatter
   * comes free with it — looking into a low sun the sky there is already warm, so distant
   * ground hazes warm on that side and stays cool on the other, with no second term.
   *
   * `weight` ramps from the flat colour to the directional sample with distance, which is
   * Unreal's pair of inscattering distances and is not a detail to drop. Haze on something
   * a few metres away is light scattered into the eye from all around it, not from the
   * patch of sky behind it; sampling directionally up close makes near fog take on the
   * sky's silhouette and the whole effect reads as a reflection.
   */
  const hazeAt = (dir: NodeArg, weight: NodeArg): NodeArg => {
    // Pitch floored, azimuth untouched — the compass bearing is what carries the sun's
    // warmth round the sky, and it is the half of the direction worth keeping.
    // NOT normalized: a cube fetch is direction-only and scale-invariant, so the
    // inversesqrt and three multiplies bought nothing on every fragment of the terrain,
    // the march, the cap and 250k blades.
    const lifted: NodeArg = V3(dir.x, dir.y.max(uHazeLift), dir.z);
    return weight
      .mul(uSkyAmount)
      .mul(uHasSky)
      .mix(uColor, skyBase.sample(lifted).blur(uSkyBlur));
  };

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
    const { base, top, antiderivative } = layer();
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
      .div(uScale)
      .negate()
      .exp();
    const throughLayer = dy
      .abs()
      .lessThan(float(1e-3))
      .select(viewZ.mul(profileAtEye), perHeight.mul(integral));

    const drift = time.mul(uDrift);
    // Two octaves from ONE fetch — the channels hold successively finer lattices, which
    // is the whole reason the bake packs four of them.
    const n = noiseAt(
      V3(worldPos.x.mul(uNoiseScale).add(drift), drift.mul(0.6), worldPos.z.mul(uNoiseScale))
    );
    const noise = n.r.mul(0.65).add(n.g.mul(0.35)).sub(0.5).mul(2);
    const modulated = noise.mul(uNoiseAmount).add(1).max(float(0));
    // Smoke adds to the SAME optical depth rather than blending as a separate layer,
    // which is what makes weather and smoke compose without an ordering to get wrong.
    const toPoint = worldPos.sub(cameraPosition);
    const rayLength = toPoint.length().max(float(1e-4));
    const viewDir = toPoint.div(rayLength);
    const smoke: NodeArg = smokeDepth(cameraPosition, viewDir, rayLength);
    // No `max(0)`: density has a slider floor of 0, throughLayer is a length, and
    // modulated is already clamped.
    const optical = uDensity.mul(throughLayer).mul(modulated);
    const ground = optical.negate().exp().oneMinus();

    // Combined as two independent extinctions rather than added, so heavy ground fog at
    // range cannot push the total past opaque and clip.
    // No clamp: a product of two values already in [0,1].
    const total: NodeArg = distance.oneMinus().mul(ground.oneMinus()).oneMinus();
    // Weather first, then smoke OVER it in its own colour. Smoke can no longer join the
    // single exponential now that it carries a colour: a coloured medium and a grey one
    // do not compose into one extinction, and the puff is the nearer of the two anyway.
    //
    // Interpolant is the receiver — `t.mix(a, b)` is `mix(a, b, t)`, the reordering
    // catalogued in docs/08 §11 that has cost this project a pale wash once already.
    // No clamp: 1 - exp(-x) with x >= 0 is in [0,1) by construction.
    const smokeAmount: NodeArg = smoke.w.negate().exp().oneMinus();
    // Colour drained on the way, at Rec. 709 luminance so the drain preserves brightness
    // and only removes hue — a green hillside going grey, not going dark.
    const lum = luminance(rgb);
    const drained: NodeArg = total.mul(uHazeDrain).mix(rgb, V3(lum, lum, lum));
    // The linear distance factor doubles as the directional weight: the more fogged a
    // surface is, the more its haze is the sky behind it rather than the ambient average.
    return smokeAmount.mix(total.mix(drained, hazeAt(viewDir, distance)), smoke.xyz);
  };

  // Shared with `apply`, and the reason the profile is written as an antiderivative:
  // the sky's ray runs to infinity, where F tends to the level itself, so the whole
  // column above the eye has a closed form rather than needing a far point invented for
  // it. Below the level that column grows as you sink into the layer; above it, it decays.
  /**
   * The slab and its antiderivative, in ONE place.
   *
   * F differentiates to the profile: an exponential tail below the base, full density
   * through the slab, an exponential tail above the top. Every exponent is clamped
   * NEGATIVE, which is the whole reason this is an antiderivative — the factored form
   * overflows to a NaN wall at small softness values, which reached the frame as a flat
   * grey band with a razor edge and read exactly like a fog artifact.
   *
   * Base and top are ORDERED here, so dragging one past the other in the panel folds the
   * slab to nothing rather than inverting it into negative optical depth.
   */
  const layer = () => {
    const base = uBase.min(uTop);
    const top = uBase.max(uTop);
    const antiderivative = (y: NodeArg): NodeArg =>
      uScale
        .mul(base.sub(y).max(float(0)).div(uScale).negate().exp())
        .add(y.clamp(base, top).sub(base))
        .add(uScale.mul(y.sub(top).max(float(0)).div(uScale).negate().exp().oneMinus()));
    return { base, top, antiderivative };
  };

  const columnAbove = (): NodeArg => {
    const { base, top, antiderivative: F } = layer();
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
    // The sky ray runs to infinity; a distance past the far plane is indistinguishable
    // from it for a volume of a few metres, and keeps the clip finite.
    const smoke: NodeArg = smokeDepth(cameraPosition, direction, float(1e5));
    const optical = uDensity.mul(columnAbove()).div(direction.y.max(float(1e-3)));
    const amount: NodeArg = optical.negate().exp().oneMinus();
    const smokeAmount: NodeArg = smoke.w.negate().exp().oneMinus();
    // THE SKY FOGS TOWARD A BLURRED VERSION OF ITSELF, which is what haze does to a sky
    // and what a constant could never do. The ground layer goes unbounded along the
    // horizon, so this term reaches full strength there; toward a flat colour that drew a
    // pale bar across the bottom of a dark sky, with the terrain silhouette cut against a
    // colour belonging to neither. Toward the sky's own low frequencies it softens instead,
    // and the terrain — now fading to the same sample — meets it with no seam at all.
    //
    // Weight is 1: this ray does run to infinity, so it is fully directional by
    // construction rather than by choice.
    return smokeAmount.mix(amount.mix(rgb, hazeAt(direction, float(1))), smoke.xyz);
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
      skyAmount: uSkyAmount,
      skyBlur: uSkyBlur,
      hazeDrain: uHazeDrain,
      hazeLift: uHazeLift,
    },
    setSky: (sky) => {
      skyBase.value = sky ?? emptySky;
      uHasSky.value = sky ? 1 : 0;
    },
    // A GRENADE, not a puff: it sits where it landed and emits until it burns out.
    spawnSmoke: (x, y, z, color) => {
      const c = color ?? "#e8e8ea";
      // Oldest canister goes out when the pool is full. Without this, enough grenades
      // starve every plume down to one puff each and none of them read at all.
      if (emitters.length >= SMOKE_MAX_EMITTERS) emitters.shift();
      emitters.push({ x, y, z, color: c, age: 0, sinceEmit: Infinity });
      // One immediately, so a thrown grenade is not invisible for its first interval.
      emitPuff(x, y, z, c);
    },
    tickSmoke: (dt) => {
      for (let e = emitters.length - 1; e >= 0; e--) {
        const em = emitters[e];
        em.age += dt;
        em.sinceEmit += dt;
        if (em.age > SMOKE_EMIT_SECONDS_TOTAL) {
          emitters.splice(e, 1);
          continue;
        }
        // INTERVAL SCALES WITH THE NUMBER OF BURNING CANISTERS, which is what stops a
        // second grenade wrecking the first. The slots are a shared pool, so three
        // emitters at a fixed interval fill it three times as fast and start recycling
        // puffs that are still on screen — the cloud visibly resets. Holding the TOTAL
        // rate constant keeps every puff alive its full life; the cost is that each plume
        // is made of fewer, longer-lived puffs when several are burning, which is a far
        // better failure than flickering.
        if (em.sinceEmit >= SMOKE_EMIT_SECONDS * emitters.length) {
          em.sinceEmit = 0;
          emitPuff(em.x, em.y, em.z, em.color);
        }
      }
      for (let i = 0; i < SMOKE_SLOTS; i++) {
        if (!Number.isFinite(smokeAge[i])) continue;
        smokeAge[i] += dt;
        const t = smokeAge[i];
        // Expands quickly then slows, and fades on a longer curve than it grows — the
        // shape of a real cloud, and it is also what makes smoke useful rather than a
        // flash: it has to stay up long enough to cross under.
        uSmoke[i].value.w =
          SMOKE_START_RADIUS +
          (SMOKE_MAX_RADIUS - SMOKE_START_RADIUS) * Math.min(1, t / SMOKE_GROW_SECONDS);
        // RISES AND DRIFTS. A puff that stays where it landed reads as a ball of fog; the
        // reference is a column leaning downwind. Both integrate on the CPU, so the shader
        // still sees one sphere and pays nothing for it.
        //
        // The rise decays, because hot gas slows as it mixes — and a puff that kept
        // climbing would leave the ground it is there to screen.
        const rise = SMOKE_RISE * SMOKE_GROW_SECONDS * (1 - Math.exp(-t / SMOKE_GROW_SECONDS));
        uSmoke[i].value.x = smokeOrigin[i].x + windX * t * SMOKE_WIND_SHARE;
        uSmoke[i].value.y = smokeOrigin[i].y + rise;
        uSmoke[i].value.z = smokeOrigin[i].z + windZ * t * SMOKE_WIND_SHARE;
        const fade = Math.max(0, 1 - t / SMOKE_LIFE_SECONDS);
        uSmokeDensity[i].value = SMOKE_DENSITY * fade * fade;
        if (t > SMOKE_LIFE_SECONDS) {
          smokeAge[i] = Infinity;
          uSmokeDensity[i].value = 0;
        }
      }
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
      windX = next.wind.x;
      windZ = next.wind.z;
      uNoiseScale.value = next.groundNoiseScale;
      uNoiseAmount.value = next.groundNoiseAmount;
      uDrift.value = next.groundDrift;
    },
  };
}
