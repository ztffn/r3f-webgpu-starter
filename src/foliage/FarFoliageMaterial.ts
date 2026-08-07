// Far-ring impostor material — hemi-octahedral view blending in TSL, one graph for both
// backends.
//
// Each instance is ONE camera-facing card textured from the baked atlas: the vertex
// stage picks the three baked views bracketing the actual view direction — a hand
// transcription of octahedral.ts's blendViews, whose behaviour the Node tests pin down —
// projects the card's plane into each view's basis, and the fragment blends the samples.
// The card is a full spherical billboard ON PURPOSE, unlike the near tier's yaw-only
// impostor: with view-dependent sampling the image content matches the tilt, so nothing
// "tips over" — that failure belongs to billboards showing a fixed side-on image.
//
// UNLIT, deliberately (plan v2 §5.1): colour is albedo × a hand-rolled sun/hemisphere
// term from the baked plant-space normals, then `atmosphere.shade` on colorNode — the
// same fog-and-grade path the terrain takes, so the far ring fogs identically to the
// ground it stands on by construction rather than through the lit subclass.

import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  mix,
  normalize,
  positionLocal,
  select,
  smoothstep,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import type { Atmosphere } from "../df2/atmosphere.ts";
import { FOLIAGE_IMPOSTOR_ALPHA_CUTOFF } from "./foliageConfig.ts";
import {
  applyCrossfade,
  type FoliageUniform,
  type FoliageUniforms,
} from "./FoliageMaterial.ts";
import type { ImpostorSpeciesAtlas } from "./impostorAtlas.ts";
import type { Species } from "./species.ts";

// The convention atmosphere.ts already uses: TSL's overloaded node types collapse to
// unusable intersections under inference, so graph-shaped values go untyped here and
// tsc checks the surrounding structure instead.
type NodeArg = any;

function vec3Uniform(x: number, y: number, z: number) {
  return uniform(new THREE.Vector3(x, y, z));
}

/**
 * Uniforms shared by every species' far material — one set drives the whole ring.
 *
 * The light values are fed per frame from the LIVE scene lights (FarFoliageCells reads
 * the refs), not from the weather preset object: the Lighting dials patch the light
 * objects in place, and a copy taken at preset time would go stale the first time a
 * dial moved.
 */
export interface FarFoliageUniforms {
  /** Outer edge of the ring, metres — instances shrink out across this band. */
  farFadeStart: FoliageUniform;
  farFadeEnd: FoliageUniform;
  /** Unit, world space, pointing from the scene TOWARD the sun. */
  sunDirection: ReturnType<typeof vec3Uniform>;
  /** Colour × intensity. */
  sunColor: ReturnType<typeof vec3Uniform>;
  fillSky: ReturnType<typeof vec3Uniform>;
  fillGround: ReturnType<typeof vec3Uniform>;
  ambient: ReturnType<typeof vec3Uniform>;
}

export function createFarFoliageUniforms(): FarFoliageUniforms {
  return {
    farFadeStart: uniform(1e6),
    farFadeEnd: uniform(1e6 + 1),
    sunDirection: vec3Uniform(0, 1, 0),
    sunColor: vec3Uniform(1, 1, 1),
    fillSky: vec3Uniform(0.4, 0.5, 0.6),
    fillGround: vec3Uniform(0.3, 0.25, 0.2),
    ambient: vec3Uniform(0.1, 0.1, 0.1),
  };
}

export interface FarFoliageMaterialOptions {
  atlas: ImpostorSpeciesAtlas;
  spritesPerSide: number;
  tileSize: number;
  species: Species;
  atmosphere: Atmosphere;
  /** The near field's shared uniforms — the grow-in band reads fadeStart/fadeEnd. */
  foliageUniforms: FoliageUniforms;
  farUniforms: FarFoliageUniforms;
}

/** Decode a hemi-oct grid tile's view direction — the shader mirror of octahedral.ts. */
function tileViewDirection(tile: NodeArg, inverseGridMax: NodeArg) {
  const enc = vec2(tile).mul(inverseGridMax).mul(2).sub(1);
  const px = enc.x.sub(enc.y).mul(0.5);
  const pz = enc.x.add(enc.y).mul(0.5);
  const py = float(1).sub(px.abs()).sub(pz.abs());
  return normalize(vec3(px, py, pz));
}

/** Horizontal-right basis for a view — the shader mirror of octahedral.ts `viewBasis`. */
function viewRight(direction: NodeArg) {
  // The epsilon keeps the zenith from dividing by zero; a 12-per-side grid has no
  // zenith tile, so this is a guard, not a rendered case.
  return normalize(vec3(direction.z, 0, direction.x.negate()).add(vec3(1e-5, 0, 0)));
}

export function createFarFoliageMaterial(options: FarFoliageMaterialOptions) {
  const { atlas, species, atmosphere, foliageUniforms, farUniforms } = options;
  const n = options.spritesPerSide;

  const material = new THREE.MeshBasicNodeMaterial();
  material.name = `foliage-far-${species.id}`;
  material.side = THREE.DoubleSide;
  material.alphaTest = FOLIAGE_IMPOSTOR_ALPHA_CUTOFF;
  material.fog = false; // atmosphere.shade IS the fog (docs/08 §7.1)

  const uRadius = float(atlas.radius);
  const uCenterY = float(atlas.centerY);
  const inverseGridMax = float(1 / (n - 1));
  const inverseGrid = float(1 / n);
  // Clamp inside the tile by half a texel so bilinear taps cannot bleed the
  // neighbouring view in — the atlas is a grid of unrelated images, not a texture.
  const halfTexel = float(0.5 / options.tileSize);

  const instanceData = attribute<"vec4">("aInstance", "vec4");
  const origin = instanceData.xyz;
  const instanceScale = instanceData.w;
  const extra = attribute<"vec4">("aData", "vec4");
  // NodeArg from here down: mixing typed swizzles with untyped graph values sends
  // TSL's overloads to the wrong resolution (the same reason atmosphere.ts is untyped).
  const cosRot: NodeArg = extra.x;
  const sinRot: NodeArg = extra.y;
  const instanceSeed: NodeArg = extra.z;

  const radius = uRadius.mul(instanceScale);
  const center = origin.add(vec3(0, uCenterY.mul(instanceScale), 0));

  // --- Card frame (vertex) ---------------------------------------------------
  const viewDir = normalize(cameraPosition.sub(center));
  const cardRight = viewRight(viewDir);
  const cardUp = viewDir.cross(cardRight);
  const cornerX = positionLocal.x;
  const cornerY = positionLocal.y;
  const offsetWorld = cardRight
    .mul(cornerX.mul(radius))
    .add(cardUp.mul(cornerY.mul(radius)));

  // --- Handoff and far fade ----------------------------------------------------
  // The near handoff DISSOLVES per pixel (FoliageMaterial's crossfade, complementary
  // pattern) — same shared uniforms, same distance-to-base, so every pixel in the band
  // shows exactly one tier at full size. Size-morphing here was the first thing a
  // player noticed once 25 m trees existed. The ring's OUTER edge keeps the shrink:
  // at 700 m it is subpixel housekeeping, not a visible transition.
  const baseDistance = origin.sub(cameraPosition).length();
  const bandPosition = varying(
    smoothstep(foliageUniforms.fadeStart, foliageUniforms.fadeEnd, baseDistance)
  );
  const sizeFactor = float(1).sub(
    smoothstep(farUniforms.farFadeStart, farUniforms.farFadeEnd, baseDistance)
  );

  material.positionNode = Fn(() => {
    // Shrink toward the base, exactly like the near tier's distance fade.
    return origin.add(center.sub(origin).add(offsetWorld).mul(sizeFactor));
  })();

  // --- View selection (vertex, per instance) ----------------------------------
  // Rotate the view into PLANT space so each instance's random yaw picks a different
  // slice of the atlas — orientation variety for free, and the same plant keeps its
  // near-tier orientation across the ring boundary.
  const viewPlant = vec3(
    cosRot.mul(viewDir.x).sub(sinRot.mul(viewDir.z)),
    viewDir.y,
    sinRot.mul(viewDir.x).add(cosRot.mul(viewDir.z))
  );
  // Hemi-oct encode; below-horizon views land outside the square and clamp to its
  // boundary, which IS the horizon ring — the fairness-preserving substitute.
  const denom = viewPlant.x.abs().add(viewPlant.y.max(0)).add(viewPlant.z.abs()).max(1e-5);
  const foldX = viewPlant.x.div(denom);
  const foldZ = viewPlant.z.div(denom);
  const encoded = vec2(foldX.add(foldZ), foldZ.sub(foldX));
  const grid = encoded.mul(0.5).add(0.5).clamp(0, 1).mul(n - 1);
  const cell = grid.floor().min(n - 2);
  const fraction = grid.sub(cell);

  // Triangle pick, mirroring blendViews: the fractional cell splits on its diagonal.
  const lower = fraction.x.add(fraction.y).lessThan(1);
  const tileA = cell.add(select(lower, vec2(0, 0), vec2(1, 1)));
  const tileB = cell.add(select(lower, vec2(1, 0), vec2(0, 1)));
  const tileC = cell.add(select(lower, vec2(0, 1), vec2(1, 0)));
  const weightB = select(lower, fraction.x, float(1).sub(fraction.x));
  const weightC = select(lower, fraction.y, float(1).sub(fraction.y));
  const weightA = float(1).sub(weightB).sub(weightC);

  // The card-plane point in plant space, for projecting into each view's frame.
  const offsetPlant = vec3(
    cosRot.mul(offsetWorld.x).sub(sinRot.mul(offsetWorld.z)),
    offsetWorld.y,
    sinRot.mul(offsetWorld.x).add(cosRot.mul(offsetWorld.z))
  );

  const viewSample = (tile: NodeArg, weight: NodeArg) => {
    const direction = tileViewDirection(tile, inverseGridMax);
    const right = viewRight(direction);
    const up = direction.cross(right);
    const tileUv = vec2(offsetPlant.dot(right), offsetPlant.dot(up))
      .div(radius.mul(2))
      .add(0.5)
      .clamp(halfTexel, float(1).sub(halfTexel));
    const atlasUv = vec2(tile).add(tileUv).mul(inverseGrid);
    // Everything above is per-vertex (exact: the projection is affine in the corner);
    // only the texture taps run per fragment.
    return varying(vec3(atlasUv, weight));
  };

  const samples = [
    viewSample(tileA, weightA),
    viewSample(tileB, weightB),
    viewSample(tileC, weightC),
  ];

  // --- Fragment: blend three views -------------------------------------------
  let alpha: NodeArg = float(0);
  let albedo: NodeArg = vec3(0, 0, 0);
  let normalPlant: NodeArg = vec3(0, 0, 0);
  for (const s of samples) {
    const albedoTexel = texture(atlas.albedo, s.xy);
    const normalTexel = texture(atlas.normalDepth, s.xy);
    alpha = alpha.add(albedoTexel.a.mul(s.z));
    albedo = albedo.add(albedoTexel.rgb.mul(s.z));
    normalPlant = normalPlant.add(normalTexel.rgb.mul(2).sub(1).mul(s.z));
  }

  // Plant-space normal back to world (inverse of the view rotation above).
  const normalWorld = normalize(
    vec3(
      cosRot.mul(normalPlant.x).add(sinRot.mul(normalPlant.z)),
      normalPlant.y,
      sinRot.mul(normalPlant.x).negate().add(cosRot.mul(normalPlant.z))
    )
  );

  // Lambert against the live sun plus hemisphere fill plus ambient — the hand-rolled
  // equivalent of the near tier's lit response, over the SAME per-instance tone.
  const upness = normalWorld.y.mul(0.5).add(0.5);
  const fill = mix(farUniforms.fillGround, farUniforms.fillSky, upness);
  const sun = farUniforms.sunColor.mul(normalWorld.dot(farUniforms.sunDirection).max(0));
  const light = farUniforms.ambient.add(fill).add(sun).mul(1 / Math.PI);
  const tone = float(0.82).add(instanceSeed.mul(0.36));

  material.colorNode = atmosphere.shade(albedo.mul(tone).mul(light));
  material.opacityNode = applyCrossfade(alpha, bandPosition, "far");

  return material;
}
