// TSL terrain material.
//
// UNLIT, and the same for both modes. Extracted DF colormaps are already
// pre-shaded — they bake lighting and shadow (docs/06 §6) — and the original
// renderer applied no lighting at all, it just painted map.color. Running PBR on
// top double-shades it, which is exactly the reasoning GrassMaterial gives for
// being unlit; when this material was Standard and the grass was Basic, the two
// disagreed about the same texture and the grass read as a different tone to the
// bare ground beside it. The synthetic fallback bakes its own shading in
// (syntheticMaps.ts) so it can take this same path.
//
// CLOSE-RANGE DETAIL: the original's near-field ground color comes from the
// detail_color strip, not the colormap — DFG5's railroad exists ONLY there
// (docs/06 §11). When the prepared assets carry the index map + tile atlas,
// each 1 m texel renders its own full 64×64 tile (tile-per-texel, ~1.6 cm/px)
// modulated over the pre-shaded colormap and faded out with distance, which is
// also how the original behaved: the track vanished at colormap range.

import * as THREE from "three/webgpu";
import {
  float,
  fract,
  fwidth,
  mix,
  positionView,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import type { Atmosphere } from "./atmosphere";

/**
 * The detail pass's live dials (dev console Scene/Weather tab via
 * visualDials.ts). Uniform writes, so tuning never rebuilds the material —
 * rebuilding discards the terrain geometry cache and stalls for ~1 s.
 */
export interface TerrainDetailUniforms {
  /** Plain brightness multiplier on the detail layer. 1 shows the tiles as
   * authored, lit by the colormap's own local shading. */
  gain: { value: number };
  /** Full detail inside this distance (metres). */
  near: { value: number };
  /** Detail fully faded past this distance (metres). */
  far: { value: number };
}

export interface TerrainMaterialOptions {
  /** Colormap: extracted for a real map, CPU-baked for the synthetic fallback. */
  colorMap: THREE.Texture;
  /**
   * The shared grade and fog, composed (atmosphere.ts).
   *
   * The .trn `filter` used to be applied here alone, which was invisible only because
   * every extracted map ships the neutral 128. The march and the blade layer sample the
   * same colormap, so a graded map would have shown ground and grass in different
   * colours the moment a preset made it non-neutral.
   */
  atmosphere: Atmosphere;
  /** Per-texel detail tile index, NEAREST-filtered (loadTerrain.ts). */
  detailIndexMap?: THREE.Texture | null;
  /** Square atlas of detail tiles (prepare-terrain.mjs detail_color.png). */
  detailColorAtlas?: THREE.Texture | null;
  /** Tiles per atlas row/column (terrain.json assets.detailColor.grid). */
  detailGrid?: number;
  /** World metres per detail-map texel — one detail tile spans one texel. */
  metersPerTexel?: number;
}

export interface TerrainMaterialKit {
  material: THREE.MeshBasicNodeMaterial;
  /** Live dials, or null when the map ships no detail assets. */
  detail: TerrainDetailUniforms | null;
}

/** Detail layer fade defaults: fully present inside NEAR, gone past FAR
 * (metres). The original resolved its detail pass over roughly this range;
 * past it only the colormap remains, which is why the railroad vanished at
 * distance. Live-tunable via visualDials. */
const DETAIL_NEAR = 48;
const DETAIL_FAR = 160;

export function createTerrainMaterial(opts: TerrainMaterialOptions): TerrainMaterialKit {
  const { colorMap, atmosphere, detailIndexMap, detailColorAtlas, detailGrid, metersPerTexel } =
    opts;

  const material = new THREE.MeshBasicNodeMaterial();

  let ground = texture(colorMap, uv()).rgb;
  let detail: TerrainDetailUniforms | null = null;

  if (detailIndexMap && detailColorAtlas && detailGrid) {
    const grid = float(detailGrid);
    const atlasWidth = (detailColorAtlas.image as { width: number }).width;
    const tileTexels = float(atlasWidth / detailGrid);

    const uGain = uniform(1);
    const uNear = uniform(DETAIL_NEAR);
    const uFar = uniform(DETAIL_FAR);
    detail = { gain: uGain, near: uNear, far: uFar };

    // The index map and the colormap share the terrain uv (both wrap with the
    // map period). NEAREST sampling returns the texel's tile index intact.
    const index = texture(detailIndexMap, uv()).r.mul(255).round();
    const cell = vec2(index.mod(grid), index.div(grid).floor());

    // Within the texel the full tile plays out: tile-per-texel (docs/06 §11).
    // Inset by half a tile texel so bilinear filtering never reads the
    // neighbouring tile across an atlas seam.
    const texelWorld = float(metersPerTexel ?? 1);
    const inTile = fract(positionWorld.xz.div(texelWorld));
    const inset = inTile.mul(tileTexels.sub(1).div(tileTexels)).add(float(0.5).div(tileTexels));
    const atlasUv = cell.add(inset).div(grid);
    const tileRgb = texture(detailColorAtlas, atlasUv).rgb;

    // Distance fade. Edges ascending — smoothstep with edge0 > edge1 is
    // undefined in WGSL and GLSL both — then inverted: near = full strength.
    // The dial can drag far below near, so far is floored a metre above it.
    const distance = positionView.length();
    const far = uFar.max(uNear.add(1));
    const distanceFade = smoothstep(uNear, far, distance).oneMinus();

    // Screen-density fade — the anti-terracing term. The index map's type
    // boundaries follow slope/height contours and are DITHERED per texel;
    // indices can't be mipmapped (averaging two tile ids names an unrelated
    // tile), so at grazing angles — where one pixel spans several texels while
    // the DISTANCE is still short — the dither aliases into contour-hugging
    // stripes. Fade the layer by how many map texels a pixel actually covers:
    // in by one-texel-per-pixel, gone by three. fwidth needs a fragment-stage
    // input, hence positionWorld rather than the vertex uv.
    const texelsPerPixel = fwidth(positionWorld.xz.div(texelWorld)).length();
    const densityFade = smoothstep(float(1), float(3), texelsPerPixel).oneMinus();

    const strength = distanceFade.mul(densityFade);

    // Lit lerp, NOT modulate. Two modulate variants were tried and both fail
    // structurally: multiplying colormap × tile in linear light darkens every
    // product of two sub-white colours and SQUARES their saturation — the
    // gamma-equivalent gain (2^2.2) fixed the mean brightness but kept the
    // saturation blowout, and a unit gain went near-black. Instead the tile
    // shows its own authored colour, lit by the colormap's local shading:
    // luminance over a deep-mip regional luminance isolates the baked
    // lighting (docs/06 §6) without polluting the tile's hue, so a rail in a
    // baked shadow darkens with the shadow while staying rail-grey.
    const LUMA = vec3(0.2126, 0.7152, 0.0722);
    const region = texture(colorMap, uv()).level(float(6)).rgb;
    const lighting = ground.dot(LUMA).div(region.dot(LUMA).max(0.02)).clamp(0.2, 3);
    const detailRgb = tileRgb.mul(lighting).mul(uGain);
    ground = mix(ground, detailRgb, strength);
  }

  material.colorNode = atmosphere.shade(ground);
  // three's AUTOMATIC fog is off, and not as an optimisation: three fogs from the
  // rasterised fragment's depth while the march fogs from its ray hit, which sits
  // somewhere else entirely. The two agreed only while both were plain linear distance;
  // a height-dependent term made the disagreement visible along every skyline.
  material.fog = false;

  // Double-sided so LOD-crack skirts fill gaps regardless of winding
  // (terrainGeometry.ts). Being unlit, a back face now shows terrain colour rather
  // than the black that made near-plane clipping look like a void.
  material.side = THREE.DoubleSide;
  return { material, detail };
}
