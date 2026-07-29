// CPU-baked colormap and canopy field for the synthetic fallback world.
//
// Exists so the no-assets path is structurally IDENTICAL to a real map: both
// supply a pre-shaded colormap plus a canopy field, so terrain and grass need no
// mode switch and the grass system is visible without any game data — previously
// the fallback rendered bare terrain and the whole grass system was unreachable.
//
// The colormap is baked WITH shading, matching how the extracted DF colormaps
// already have lighting and shadow painted in (docs/06 §6). That keeps one
// unlit terrain material for both modes instead of double-shading one of them.

import * as THREE from "three/webgpu";
import { fbm } from "./noise";
import { SUN_DIRECTION, TERRAIN_HEIGHT } from "./config";
import type { Heightfield } from "./Heightfield";

// Biome ramp, low to high. Lives here rather than in the material because it is
// evaluated once on the CPU now, not per fragment.
const SAND: [number, number, number] = [0.76, 0.69, 0.5];
const GRASS: [number, number, number] = [0.3, 0.43, 0.19];
const GRASS_DARK: [number, number, number] = [0.2, 0.31, 0.13];
const ROCK: [number, number, number] = [0.4, 0.38, 0.35];
const SNOW: [number, number, number] = [0.9, 0.93, 0.97];

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Height/slope biome blend, mirroring what the old TSL graph produced. */
function biome(h01: number, slopeY: number): [number, number, number] {
  let c = mix(SAND, GRASS, smoothstep(0.03, 0.1, h01));
  c = mix(c, GRASS_DARK, smoothstep(0.1, 0.42, h01));
  c = mix(c, ROCK, smoothstep(0.48, 0.72, h01));
  c = mix(c, SNOW, smoothstep(0.82, 0.95, h01));
  // Steep faces read as exposed rock, overriding the height bands.
  const rockFactor = 1 - smoothstep(0.55, 0.82, slopeY);
  return mix(c, ROCK, rockFactor * 0.9);
}

export interface SyntheticMaps {
  colorMap: THREE.DataTexture;
  grassMap: THREE.DataTexture;
  /** Samples per side of the two maps above — the COLOUR texel grid. */
  size: number;
}

/**
 * Bake a pre-shaded colormap and a canopy field from a synthetic field.
 *
 * Baked at `COLOR_SCALE` times the elevation grid so the colour texel comes out at
 * 2 m, matching a real DF map. That matters because the grass shader fetches each
 * column's colour at its TERRAIN TEXEL CENTRE — a deliberate nearest-neighbour
 * lookup — so the texel size is directly visible as the width of a flat-coloured
 * block. At the elevation grid's own 4 m spacing those blocks read as obvious
 * tiling that the real map does not have.
 */
const COLOR_SCALE = 2;

export function bakeSyntheticMaps(heightfield: Heightfield): SyntheticMaps {
  const size = heightfield.period * COLOR_SCALE;
  const cellSize = heightfield.worldSize / size;
  const { halfWorld } = heightfield;

  const rgba = new Uint8Array(size * size * 4);
  const canopy = new Uint8Array(size * size);

  const sun = (() => {
    const [x, y, z] = SUN_DIRECTION;
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l] as const;
  })();

  const nrm: [number, number, number] = [0, 1, 0];

  for (let j = 0; j < size; j++) {
    const wz = -halfWorld + j * cellSize;
    for (let i = 0; i < size; i++) {
      const wx = -halfWorld + i * cellSize;
      const idx = j * size + i;

      // sample(), not grid[idx]: this grid is finer than the elevation grid.
      const h = heightfield.sample(wx, wz);
      heightfield.normal(wx, wz, nrm);
      const h01 = Math.min(1, Math.max(0, h / TERRAIN_HEIGHT));
      const [r, g, b] = biome(h01, nrm[1]);

      // Bake the lighting in, so the material can stay unlit like the real maps.
      const lambert = Math.max(0, nrm[0] * sun[0] + nrm[1] * sun[1] + nrm[2] * sun[2]);
      const shade = 0.45 + 0.55 * lambert;

      rgba[idx * 4] = Math.round(Math.min(1, r * shade) * 255);
      rgba[idx * 4 + 1] = Math.round(Math.min(1, g * shade) * 255);
      rgba[idx * 4 + 2] = Math.round(Math.min(1, b * shade) * 255);
      rgba[idx * 4 + 3] = 255;

      // Canopy grows in low, flat ground and thins on slopes and peaks — the same
      // relationship the real detail map encodes, arrived at from terrain instead.
      const u = i / size;
      const v = j / size;
      const patch = fbm(u * 6, v * 6, { seed: 4242, octaves: 4, period: 6 });
      const lowland = 1 - smoothstep(0.12, 0.55, h01);
      const flat = smoothstep(0.72, 0.95, nrm[1]);
      canopy[idx] = Math.round(255 * Math.min(1, lowland * flat * (0.35 + 0.75 * patch)));
    }
  }

  const colorMap = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.wrapS = THREE.RepeatWrapping;
  colorMap.wrapT = THREE.RepeatWrapping;
  colorMap.magFilter = THREE.LinearFilter;
  colorMap.minFilter = THREE.LinearMipmapLinearFilter;
  colorMap.generateMipmaps = true;
  colorMap.anisotropy = 8;
  colorMap.needsUpdate = true;

  const grassMap = new THREE.DataTexture(
    canopy,
    size,
    size,
    THREE.RedFormat,
    THREE.UnsignedByteType
  );
  grassMap.wrapS = THREE.RepeatWrapping;
  grassMap.wrapT = THREE.RepeatWrapping;
  grassMap.magFilter = THREE.LinearFilter;
  grassMap.minFilter = THREE.LinearFilter;
  grassMap.needsUpdate = true;

  return { colorMap, grassMap, size };
}
