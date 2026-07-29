// Baked per-column jitter and tone, as one tiling RG texture.
//
// Replaces nine sin()-based hash evaluations per march sample with one texture
// fetch. Measured: identical sample count, 99.8 ms -> 12.57 ms. The hash was ~87%
// of the entire grass cost, because the march has to evaluate the jittered column
// height at EVERY sample — the jitter is the geometry being intersected, so it
// cannot be hoisted out of the loop or deferred to the hit.
//
//   R = column height multiplier field (was clump(cell, 0))
//   G = per-column tone field          (was clump(cell, 17.3))
//
// Baked with the project's own fbm (noise.ts) rather than a port of the shader's
// sin hash. The two are not bit-identical and do not need to be: this bake becomes
// the definition, and fbm is both faster on the CPU and already deterministic
// across runs, which the concealment field depends on.

import * as THREE from "three/webgpu";
import { fbm } from "./noise";

/**
 * Texels per side.
 *
 * Deliberately NOT one texel per grass cell. Over a 120 m period at 0.03 m cells
 * that would be 4000² and a 16 MB upload, and it would buy nothing: the clump field
 * it replaces has noise lattices at 14 and 5 CELLS — 0.42 m and 0.15 m — so 85% of
 * its energy is already coarser than a tenth of a metre. At 1024² over 120 m a texel
 * is 0.117 m, which resolves everything except the finest per-cell grain term.
 *
 * It also means the texture does not depend on cellSize, so the column-width slider
 * keeps working without a rebake.
 */
const RESOLUTION = 1024;

export interface GrassJitter {
  texture: THREE.DataTexture;
  /** Metres the pattern repeats over. Must match what the shader divides by. */
  period: number;
}

/**
 * Bake the jitter/tone fields over a `period`-metre tile.
 *
 * Both fields are two octaves plus a grain term, matching the shape of the shader's
 * clump(): a broad tuft scale, a medium scale, and fine variation. Frequencies are
 * expressed in cycles per tile so the result is seamless.
 */
export function bakeGrassJitter(period: number): GrassJitter {
  const size = RESOLUTION;
  const data = new Uint8Array(size * size * 2);

  // Tuft sizes in metres, converted to cycles across the tile. 6 m broad clumps and
  // 1.6 m medium variation read as the reference's tufting at eye height.
  const broad = Math.max(1, Math.round(period / 6));
  const medium = Math.max(1, Math.round(period / 1.6));
  const grain = Math.max(1, Math.round(period / 0.35));

  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const idx = (j * size + i) * 2;

      // Height multiplier. Weighted like the shader's clump(): mostly broad, some
      // medium, a little grain.
      const h =
        fbm(u * broad, v * broad, { seed: 1301, octaves: 2, period: broad }) * 0.55 +
        fbm(u * medium, v * medium, { seed: 2207, octaves: 2, period: medium }) * 0.3 +
        fbm(u * grain, v * grain, { seed: 3313, octaves: 1, period: grain }) * 0.15;

      // Tone field, independent of height so a tall column is not always a bright
      // one — that correlation reads as embossing rather than as grass.
      const t =
        fbm(u * broad, v * broad, { seed: 5417, octaves: 2, period: broad }) * 0.55 +
        fbm(u * medium, v * medium, { seed: 6521, octaves: 2, period: medium }) * 0.3 +
        fbm(u * grain, v * grain, { seed: 7621, octaves: 1, period: grain }) * 0.15;

      data[idx] = Math.max(0, Math.min(255, Math.round(h * 255)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(t * 255)));
    }
  }

  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGFormat,
    THREE.UnsignedByteType
  );
  // NEAREST: columns must stay discrete blocks. Linear here would smooth the
  // canopy into a continuous surface and lose the hard vertical edges entirely.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;

  return { texture, period };
}
