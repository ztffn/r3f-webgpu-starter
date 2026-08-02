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
import { texture, uv } from "three/tsl";
import type { Atmosphere } from "./atmosphere";

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
}

export function createTerrainMaterial(
  opts: TerrainMaterialOptions
): THREE.MeshBasicNodeMaterial {
  const { colorMap, atmosphere } = opts;

  const material = new THREE.MeshBasicNodeMaterial();

  material.colorNode = atmosphere.shade(texture(colorMap, uv()));
  // three's AUTOMATIC fog is off, and not as an optimisation: three fogs from the
  // rasterised fragment's depth while the march fogs from its ray hit, which sits
  // somewhere else entirely. The two agreed only while both were plain linear distance;
  // a height-dependent term made the disagreement visible along every skyline.
  material.fog = false;

  // Double-sided so LOD-crack skirts fill gaps regardless of winding
  // (terrainGeometry.ts). Being unlit, a back face now shows terrain colour rather
  // than the black that made near-plane clipping look like a void.
  material.side = THREE.DoubleSide;
  return material;
}
