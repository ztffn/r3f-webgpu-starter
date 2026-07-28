// TSL terrain material.
//
// Two modes, one material class:
//   - Real map: sample the extracted colormap (already pre-shaded by the original
//     authoring tools — it bakes in lighting/shadow), optionally tinted by the
//     terrain's `filter` RGB from its .trn manifest.
//   - Synthetic: a procedural biome blend from world-space height and slope.
//
// Being a *Standard* node material it keeps PBR response to the scene's sun,
// hemisphere fill, and fog for free (docs/03-terrain-and-grass-rendering-design.md §3).

import * as THREE from "three/webgpu";
import { positionWorld, normalWorld, vec3, mix, smoothstep, texture, uv } from "three/tsl";
import { TERRAIN_HEIGHT } from "./config";

export interface TerrainMaterialOptions {
  /** Extracted colormap. When present it replaces the procedural biome blend. */
  colorMap?: THREE.Texture | null;
  /** `filter` RGB from the .trn manifest (0-255 each, 128 = neutral). */
  filter?: [number, number, number];
  /** Peak height of the synthetic field, used only for the procedural blend. */
  peakHeight?: number;
}

function proceduralBiome(peakHeight: number) {
  const h = positionWorld.y.div(peakHeight).clamp(0.0, 1.0);
  const slope = normalWorld.y.clamp(0.0, 1.0);

  const sand = vec3(0.76, 0.69, 0.5);
  const grass = vec3(0.3, 0.43, 0.19);
  const grassDark = vec3(0.2, 0.31, 0.13);
  const rock = vec3(0.4, 0.38, 0.35);
  const snow = vec3(0.9, 0.93, 0.97);

  let color = mix(sand, grass, smoothstep(0.03, 0.1, h));
  color = mix(color, grassDark, smoothstep(0.1, 0.42, h));
  color = mix(color, rock, smoothstep(0.48, 0.72, h));
  color = mix(color, snow, smoothstep(0.82, 0.95, h));

  // Steep faces read as exposed rock, overriding the height bands.
  const rockFactor = smoothstep(0.55, 0.82, slope).oneMinus();
  return mix(color, rock, rockFactor.mul(0.9));
}

export function createTerrainMaterial(
  opts: TerrainMaterialOptions = {}
): THREE.MeshStandardNodeMaterial {
  const { colorMap = null, filter, peakHeight = TERRAIN_HEIGHT } = opts;

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.96,
    metalness: 0.0,
  });

  if (colorMap) {
    const sampled = texture(colorMap, uv());
    // .trn `filter` is an RGB tint where 128 is neutral.
    const neutral = !filter || (filter[0] === 128 && filter[1] === 128 && filter[2] === 128);
    material.colorNode = neutral
      ? sampled
      : sampled.mul(vec3(filter[0] / 128, filter[1] / 128, filter[2] / 128));
  } else {
    material.colorNode = proceduralBiome(peakHeight);
  }

  // Double-sided so LOD-crack skirts fill gaps regardless of winding
  // (terrainGeometry.ts).
  material.side = THREE.DoubleSide;
  return material;
}
