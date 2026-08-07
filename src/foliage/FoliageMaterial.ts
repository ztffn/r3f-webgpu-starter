// Foliage material — TSL, one graph for both the WebGPU and WebGL2 backends.
//
// FOUR ALPHA MODES, BECAUSE THE ANSWER IS HARDWARE-DEPENDENT
// glTF's BLEND is a poor default for leaves: it enters the transparent queue, stops
// writing depth, and makes overlapping foliage order-sensitive — so the cover a player
// sees depends on draw order rather than on what is there. MASK is the baseline. Whether
// alpha-to-coverage or alpha hash is better on top of it is an empirical question about
// the adapter and about whether this project ever gets stable temporal AA, so all four
// are switchable at runtime and none is hard-coded.
//
// VERIFIED ABOUT THIS STACK (three 0.185.1, read from source, not assumed):
//
//   * alpha-to-coverage IS wired on the WebGPU backend —
//     `WebGPUPipelineUtils` sets `multisample.alphaToCoverageEnabled = material.alphaToCoverage
//     && sampleCount > 1`. It therefore does NOTHING without MSAA.
//   * MSAA is already on. React Three Fiber's default renderer props include
//     `antialias: true`, and `GameCanvas` forwards those props straight into
//     `WebGPURenderer`, so this project already runs 4x MSAA. The WebGPU backend clamps
//     the sample count to 4 or 1 — there is no 2x.
//   * `NodeMaterial` treats alphaToCoverage as a real coverage path, not a flag: with
//     it set, alpha becomes `smoothstep(alphaTest, alphaTest + fwidth(a), a)` and
//     `NodeBuilder.isOpaque()` returns false so that value survives to the output. It is
//     therefore INERT unless `alphaTest > 0` is also set.
//   * `alphaHash` discards against a hash of `positionLocal` — a WORLD-anchored pattern,
//     so it does not crawl when the camera moves. It still grains under motion, which is
//     what TAA would be for and this project has none.

import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Atmosphere } from "../df2/atmosphere.ts";
import type { Species } from "./species.ts";
import {
  FOLIAGE_ALPHA_CUTOFF,
  FOLIAGE_WIND_AMPLITUDE,
  FOLIAGE_WIND_PERIOD_SECONDS,
} from "./foliageConfig.ts";

export type FoliageAlphaMode = "mask" | "mask-a2c" | "hash" | "blend";

export const FOLIAGE_ALPHA_MODES: readonly FoliageAlphaMode[] = [
  "mask",
  "mask-a2c",
  "hash",
  "blend",
];

/**
 * A float uniform, with its node type preserved.
 *
 * `ReturnType<typeof uniform>` — the shorthand used elsewhere in this codebase — resolves
 * to the LAST overload of a heavily overloaded signature and lands on
 * `UniformNode<unknown, unknown>`, which has no arithmetic methods at all. Going through
 * a concretely typed wrapper keeps `.mul()` and friends available.
 */
function floatUniform(value: number) {
  return uniform(value);
}

export type FoliageUniform = ReturnType<typeof floatUniform>;

export interface FoliageUniforms {
  /**
   * Seconds on the WORLD clock, not on `performance.now()`.
   *
   * A fairness requirement rather than a style choice: wind deforms the silhouette that
   * conceals a player, so two clients must agree on its phase. Driving it from a shared
   * world time is what makes that possible later without redesigning the material now.
   */
  time: FoliageUniform;
  windAmplitude: FoliageUniform;
  windPeriod: FoliageUniform;
  fadeStart: FoliageUniform;
  fadeEnd: FoliageUniform;
}

export interface FoliageMaterialOptions {
  map: THREE.Texture;
  species: Species;
  alphaMode: FoliageAlphaMode;
  /**
   * The scene's atmosphere. NOT optional in practice, and the reason it is threaded this
   * far down: this material is LIT, so without it foliage takes three's automatic linear
   * scene fog — a flat colour — while the terrain it stands on fades to the sky cubemap
   * sampled along the view ray. That is the "foliage reads darker than the terrain"
   * defect the design record opened with (§7.3).
   */
  atmosphere: Atmosphere;
  /** Shared across every species' material so one slider drives the whole system. */
  uniforms?: FoliageUniforms;
  windAmplitude?: number;
  windPeriod?: number;
  fadeStart?: number;
  fadeEnd?: number;
}

export function createFoliageUniforms(options?: {
  windAmplitude?: number;
  windPeriod?: number;
  fadeStart?: number;
  fadeEnd?: number;
}): FoliageUniforms {
  return {
    time: floatUniform(0),
    windAmplitude: floatUniform(options?.windAmplitude ?? FOLIAGE_WIND_AMPLITUDE),
    windPeriod: floatUniform(options?.windPeriod ?? FOLIAGE_WIND_PERIOD_SECONDS),
    fadeStart: floatUniform(options?.fadeStart ?? 1e6),
    fadeEnd: floatUniform(options?.fadeEnd ?? 1e6 + 1),
  };
}

export interface FoliageMaterial {
  material: THREE.MeshStandardNodeMaterial;
  uniforms: FoliageUniforms;
}

/**
 * Builds one species' material.
 *
 * Lit, unlike the grass march. The grass is unlit because the colormap it samples is
 * pre-shaded and PBR double-shades it (docs/08 §6.4). Foliage is different in kind: it is
 * new geometry standing ABOVE that colormap, casting its own silhouette against the sky,
 * and an unlit bush in a lit scene reads as a sticker. The cost is that its shading must
 * be kept close enough to the baked sun in the colormap that the two do not argue —
 * `SUN_DIRECTION` is the shared reference.
 */
export function createFoliageMaterial(options: FoliageMaterialOptions): FoliageMaterial {
  const { map, species, alphaMode } = options;
  const uniforms = options.uniforms ?? createFoliageUniforms(options);

  // Grade and fog AFTER lighting, which is the only correct point for a lit surface —
  // `colorNode` would fog the albedo and then light the fog. Before this, a bush at 200 m
  // faded toward the flat preset fog colour while the terrain under it faded toward the
  // sky cubemap: the "foliage reads darker than the terrain" defect of the design record.
  const Material = options.atmosphere.litClass(THREE.MeshStandardNodeMaterial);
  const material = new Material();
  material.name = `foliage-${species.id}-${alphaMode}`;
  material.side = THREE.DoubleSide;
  material.roughness = 0.92;
  material.metalness = 0;
  // NO normalNode override. `Normal.js` already applies `negateOnBackSide`, so a
  // double-sided leaf lights correctly from behind for free; overriding the normal is
  // what shades every back face black (docs/08 §6.4 records that exact mistake on grass).

  // Explicit type arguments: `attribute`'s node type parameter is unconstrained, so an
  // inferred string literal widens to `string` and every chained operation on the result
  // then fails to resolve. Naming the type is the whole fix.
  // PACKED, to stay inside WebGPU's eight vertex buffers. Declared one-per-value this
  // material asked for ten and every pipeline failed to create, so nothing was drawn —
  // foliageGeometry's packing note has the error and why a software rasteriser hid it.
  // `aCard` is (card.xy, sway, billboard); `aInstance` is (origin.xyz, scale).
  const cardData = attribute<"vec4">("aCard", "vec4");
  const cardOffset = cardData.xy;
  const swayAttribute = cardData.z;
  const billboardFlag = cardData.w;
  const leafFlag = attribute<"float">("leaf", "float");
  const instanceData = attribute<"vec4">("aInstance", "vec4");
  const instanceOrigin = instanceData.xyz;
  const instanceScale = instanceData.w;
  const instanceSeed = attribute<"float">("aSeed", "float");

  material.positionNode = Fn(() => {
    // `positionLocal` here is already instance-transformed: NodeMaterial applies the
    // instance matrix BEFORE it evaluates positionNode and then ASSIGNS this result over
    // it. Reading positionLocal and adding to it is therefore mandatory — returning a
    // freshly built position would silently drop every instance transform and stack the
    // whole cell at its origin.
    const local = positionLocal.toVar();
    const offset = local.sub(instanceOrigin).toVar();

    // World position of the plant's base, for wind phase and for distance fade. The mesh
    // transform is a pure translation (the cell's origin), so this is exact.
    const worldOrigin = modelWorldMatrix.mul(vec4(instanceOrigin, 1)).xyz.toVar();

    // --- Cylindrical billboard (impostor LOD) --------------------------------
    // Yaw-only, which is correct for vegetation: a full spherical billboard tips a tree
    // over as the camera pitches down, and this camera spends its time prone.
    const toCamera = vec2(
      worldOrigin.x.sub(cameraPosition.x),
      worldOrigin.z.sub(cameraPosition.z)
    );
    const right = normalize(vec3(toCamera.y.negate(), 0, toCamera.x));
    const billboardOffset = right
      .mul(cardOffset.x.mul(instanceScale))
      .add(vec3(0, cardOffset.y.mul(instanceScale), 0));
    // Receiver-is-interpolant: `t.mix(a, b)` compiles to `mix(a, b, t)`. Written the GLSL
    // way this becomes a valid expression with the operands rotated and no error at all
    // (docs/08 §11) — hence the explicit free-function form here.
    offset.assign(mix(offset, billboardOffset, billboardFlag));

    // --- Wind ----------------------------------------------------------------
    // Phase from world position and the world clock only. No per-instance random and no
    // frame counter, so the deformation is reproducible anywhere from (position, time).
    const phase = uniforms.time
      .mul(float(Math.PI * 2).div(uniforms.windPeriod))
      .add(worldOrigin.x.mul(0.09))
      .add(worldOrigin.z.mul(0.13))
      .add(instanceSeed.mul(1.7));
    const gust = float(0.72).add(phase.mul(0.31).sin().mul(0.28));
    const amplitude = uniforms.windAmplitude.mul(swayAttribute).mul(leafFlag).mul(gust);
    offset.addAssign(
      vec3(phase.sin().mul(amplitude), 0, phase.mul(0.83).cos().mul(amplitude.mul(0.6)))
    );

    // --- Distance fade -------------------------------------------------------
    // Shrink toward the base rather than fade the alpha. An alpha ramp under an alpha
    // TEST does not fade — it holds full opacity and then vanishes at the cutoff — and
    // the memo's own advice is to earn a dithered cross-fade with a measurement rather
    // than assume one. Shrinking is order-independent, needs no second draw, and keeps
    // the plant fully opaque for as long as it is visible at all.
    const distance = worldOrigin.sub(cameraPosition).length();
    const fade = float(1).sub(smoothstep(uniforms.fadeStart, uniforms.fadeEnd, distance));
    offset.mulAssign(fade);

    return instanceOrigin.add(offset);
  })();

  const texel = texture(map, uv());
  const tint = vec3(species.foliageTint[0], species.foliageTint[1], species.foliageTint[2]);
  // Per-instance tone, so a stand of one species does not read as a stamped repeat. One
  // tone per plant, not per card: a plant that varies within itself reads as noise.
  const tone = float(0.82).add(instanceSeed.mul(0.36));
  const bark = vec3(0.19, 0.15, 0.11);

  material.colorNode = mix(bark, tint.mul(tone), leafFlag);
  material.opacityNode = mix(float(1), texel.a, leafFlag);

  applyAlphaMode(material, alphaMode);

  return { material, uniforms };
}

/** The one place the four modes differ, so a comparison cannot drift between them. */
export function applyAlphaMode(
  material: THREE.MeshStandardNodeMaterial,
  mode: FoliageAlphaMode
): void {
  material.alphaTest = 0;
  material.alphaHash = false;
  material.alphaToCoverage = false;
  material.transparent = false;
  material.depthWrite = true;

  if (mode === "mask") {
    material.alphaTest = FOLIAGE_ALPHA_CUTOFF;
  } else if (mode === "mask-a2c") {
    // Both, not either: NodeMaterial's coverage path is written inside the alphaTest
    // branch, so alphaToCoverage alone compiles to nothing.
    material.alphaTest = FOLIAGE_ALPHA_CUTOFF;
    material.alphaToCoverage = true;
  } else if (mode === "hash") {
    material.alphaHash = true;
  } else {
    material.transparent = true;
    material.depthWrite = false;
  }
  material.needsUpdate = true;
}
