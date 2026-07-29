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
import { vec3, texture, uv } from "three/tsl";

export interface TerrainMaterialOptions {
  /** Colormap: extracted for a real map, CPU-baked for the synthetic fallback. */
  colorMap: THREE.Texture;
  /** `filter` RGB from the .trn manifest (0-255 each, 128 = neutral). */
  filter?: [number, number, number];
}

export function createTerrainMaterial(
  opts: TerrainMaterialOptions
): THREE.MeshBasicNodeMaterial {
  const { colorMap, filter } = opts;

  const material = new THREE.MeshBasicNodeMaterial();

  const sampled = texture(colorMap, uv());
  // .trn `filter` is an RGB tint where 128 is neutral.
  const neutral = !filter || (filter[0] === 128 && filter[1] === 128 && filter[2] === 128);
  material.colorNode = neutral
    ? sampled
    : sampled.mul(vec3(filter[0] / 128, filter[1] / 128, filter[2] / 128));

  // Double-sided so LOD-crack skirts fill gaps regardless of winding
  // (terrainGeometry.ts). Being unlit, a back face now shows terrain colour rather
  // than the black that made near-plane clipping look like a void.
  material.side = THREE.DoubleSide;
  return material;
}
