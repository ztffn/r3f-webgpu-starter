// TSL terrain material.
//
// A MeshStandardNodeMaterial whose albedo (colorNode) is a shader graph that
// blends biome colors from world-space height and slope. Being a *Standard* node
// material, it keeps PBR response to the scene's sun, hemisphere fill, and fog
// for free (docs/03-terrain-and-grass-rendering-design.md §3).
//
// When real assets arrive, this procedural colorNode is swapped for a
// texture(colormap) sample + detail overlay — the mesh/LOD code is untouched.

import * as THREE from "three/webgpu";
import { positionWorld, normalWorld, vec3, mix, smoothstep } from "three/tsl";
import { TERRAIN_HEIGHT } from "./config";

export function createTerrainMaterial(): THREE.MeshStandardNodeMaterial {
  // Normalized height [0,1] and flatness [0,1] (slope = normal.y; 1 = flat).
  const h = positionWorld.y.div(TERRAIN_HEIGHT).clamp(0.0, 1.0);
  const slope = normalWorld.y.clamp(0.0, 1.0);

  const sand = vec3(0.76, 0.69, 0.5);
  const grass = vec3(0.3, 0.43, 0.19);
  const grassDark = vec3(0.2, 0.31, 0.13);
  const rock = vec3(0.4, 0.38, 0.35);
  const snow = vec3(0.9, 0.93, 0.97);

  // Height bands: beach -> grass -> darker grass -> rock -> snow caps.
  let color = mix(sand, grass, smoothstep(0.03, 0.1, h));
  color = mix(color, grassDark, smoothstep(0.1, 0.42, h));
  color = mix(color, rock, smoothstep(0.48, 0.72, h));
  color = mix(color, snow, smoothstep(0.82, 0.95, h));

  // Steep faces read as exposed rock, overriding the height bands.
  const rockFactor = smoothstep(0.55, 0.82, slope).oneMinus();
  color = mix(color, rock, rockFactor.mul(0.9));

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 0.96,
    metalness: 0.0,
  });
  material.colorNode = color;
  // Double-sided so LOD-crack skirts fill gaps regardless of winding
  // (terrainGeometry.ts).
  material.side = THREE.DoubleSide;
  return material;
}
