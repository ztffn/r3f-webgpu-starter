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

import * as THREE from "three/webgpu";
import { positionWorld, texture, uv } from "three/tsl";
import type { ColorGrade } from "./colorGrade";
import type { Fog } from "./fog";

export interface TerrainMaterialOptions {
  /** Colormap: extracted for a real map, CPU-baked for the synthetic fallback. */
  colorMap: THREE.Texture;
  /**
   * The shared weather grade (colorGrade.ts).
   *
   * The .trn `filter` used to be applied here alone, which was invisible only because
   * every extracted map ships the neutral 128. The march and the blade layer sample the
   * same colormap, so a graded map would have shown ground and grass in different
   * colours the moment a preset made it non-neutral.
   */
  grade: ColorGrade;
  /**
   * Shared atmosphere (fog.ts).
   *
   * Terrain used three's AUTOMATIC scene fog until the ground layer arrived, and that
   * could not stay: three fogs from the rasterised fragment's depth, while the march
   * fogs from its ray hit — which sits at a different place entirely — so the two only
   * agreed while both were plain linear distance. A height-dependent term makes the
   * disagreement visible along every skyline. `material.fog` is off below for that
   * reason, not as an optimisation.
   */
  fog: Fog;
}

export function createTerrainMaterial(
  opts: TerrainMaterialOptions
): THREE.MeshBasicNodeMaterial {
  const { colorMap, grade, fog } = opts;

  const material = new THREE.MeshBasicNodeMaterial();

  // Graded, then fogged — never the other way round. The fog colour belongs to the
  // weather preset and already carries the hour; grading it again would drag the horizon
  // away from the sky it has to meet.
  material.colorNode = fog.apply(grade.apply(texture(colorMap, uv())), positionWorld);
  material.fog = false;

  // Double-sided so LOD-crack skirts fill gaps regardless of winding
  // (terrainGeometry.ts). Being unlit, a back face now shows terrain colour rather
  // than the black that made near-plane clipping look like a void.
  material.side = THREE.DoubleSide;
  return material;
}
