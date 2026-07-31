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
import { fbm, hash2 } from "./noise";

/**
 * Texels per side, mapped across `period` METRES — one texel is 0.117 m at the
 * shipped 120 m period.
 *
 * PER-CELL MAPPING WAS TRIED AND REVERTED; do not reinstate it. Sampling one texel
 * per grass cell resolves a strand, which looks right and is the obvious thing to
 * want — and it HALVED THE FRAME RATE. The march evaluates column height at every
 * sample, and at sub-centimetre columns a single march step spans tens of texels, so
 * every one of those fetches misses the texture cache instead of hitting it. The
 * metre mapping is what makes one fetch per sample affordable at all. See the note
 * beside `jitterAt` in GrassMaterial.ts.
 *
 * So this texture supplies COARSE clumping only. Per-strand detail comes from
 * `strandHash` in the shader — about six ALU operations against a cache miss costing
 * hundreds of cycles — mixed in at `GRASS_STRAND_MIX`. That split is a cache decision
 * before it is a visual one.
 *
 * Raising this trades memory for detail within the same 120 m repeat: 2048² is 8 MB
 * and halves the texel to 0.059 m.
 */
const RESOLUTION = 1024;

/**
 * Bake the jitter/tone fields over a `period`-metre tile.
 *
 * Both fields are two octaves plus a grain term, matching the shape of the shader's
 * clump(): a broad tuft scale, a medium scale, and fine variation. Frequencies are
 * expressed in cycles per tile so the result is seamless.
 */
/**
 * Per-texel white noise that tiles over `size`.
 *
 * The tone field's finest fbm lattice is 0.35 m, which at 0.03 m columns is about twelve
 * columns wide — so NEIGHBOURING columns shared a tone and there was no corduroy at all,
 * only broad patches. Corduroy is by definition variation between adjacent columns, so it
 * has to come from a term at texel resolution.
 *
 * Uses the project's own `hash2` rather than a private copy: it is the hash `fbm` is built
 * on, and noise.ts records that its determinism is load-bearing for the concealment field.
 * Two copies could drift.
 */
const texelNoise = (i: number, j: number, seed: number, size: number): number =>
  hash2(i, j, seed, size);

/**
 * Map a field onto the full 0-1 range by standardising it, mean ± 2σ -> 0..1.
 *
 * fbm returns a normalised weighted AVERAGE of value-noise samples, so it clusters
 * hard around 0.5: measured over this tile the tone field had σ = 0.107, which made
 * the typical column-to-column brightness variation ±9% even with the dial at 0.85.
 * The dial claimed a range the data never used, so grass rendered flat. A plain
 * min/max stretch would be hostage to single outliers; ±2σ clips about 5% at each
 * end, which is what gives the field its full contrast.
 */
function standardise(field: Float32Array): void {
  let sum = 0;
  for (let k = 0; k < field.length; k++) sum += field[k];
  const mean = sum / field.length;
  let sum2 = 0;
  for (let k = 0; k < field.length; k++) {
    const d = field[k] - mean;
    sum2 += d * d;
  }
  const sd = Math.sqrt(sum2 / field.length) || 1;
  for (let k = 0; k < field.length; k++) {
    field[k] = Math.max(0, Math.min(1, 0.5 + (field[k] - mean) / (4 * sd)));
  }
}

/**
 * @param period Metres the pattern repeats over.
 * @param strandJitter Share of the HEIGHT field carried by per-texel noise, 0-1.
 *
 *   Height variation was limited by frequency, not amplitude. The multiplier already
 *   spanned 0.38-1.00 of the canopy, but one texel is 0.117 m — about four strands at
 *   0.03 m — and the finest fbm term sits at 0.35 m, roughly twelve strands. So the
 *   canopy top rolled in clumps where the DF2 references show a ragged per-strand edge
 *   (docs/07 §1.3).
 *
 *   This trades some of the fbm weight for noise at texel resolution, which is the
 *   highest frequency this texture can express. It is deliberately a dial rather than a
 *   constant: the march evaluates column height at every sample, and a one-texel-wide
 *   spike is exactly what a 12-sample coarse pass can step over, so raising this can buy
 *   shimmer under motion instead of detail. `?strand=` overrides it for A/B.
 */
export function bakeGrassJitter(period: number, strandJitter = 0): THREE.DataTexture {
  const size = RESOLUTION;
  // Trade against the fbm terms rather than adding on top, so the field keeps its
  // overall scale and `strandJitter = 0` reproduces the previous bake exactly.
  const fbmWeight = 1 - Math.max(0, Math.min(1, strandJitter));
  const data = new Uint8Array(size * size * 2);
  const heights = new Float32Array(size * size);
  const tones = new Float32Array(size * size);

  // Tuft sizes in metres, converted to cycles across the tile. 6 m broad clumps and
  // 1.6 m medium variation read as the reference's tufting at eye height.
  const broad = Math.max(1, Math.round(period / 6));
  const medium = Math.max(1, Math.round(period / 1.6));
  const grain = Math.max(1, Math.round(period / 0.35));

  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const k = j * size + i;

      // Height multiplier. Weighted like the shader's clump(): mostly broad, some
      // medium, a little grain — plus, at `strandJitter`, noise at texel resolution
      // for the ragged per-strand canopy edge the references show.
      heights[k] =
        (fbm(u * broad, v * broad, { seed: 1301, octaves: 2, period: broad }) * 0.55 +
          fbm(u * medium, v * medium, { seed: 2207, octaves: 2, period: medium }) * 0.3 +
          fbm(u * grain, v * grain, { seed: 3313, octaves: 1, period: grain }) * 0.15) *
          fbmWeight +
        texelNoise(i, j, 4409, size) * strandJitter;

      // Tone field, independent of height so a tall column is not always a bright
      // one — that correlation reads as embossing rather than as grass.
      // The clump octaves give tufting; the per-texel term gives the corduroy.
      tones[k] =
        fbm(u * broad, v * broad, { seed: 5417, octaves: 2, period: broad }) * 0.42 +
        fbm(u * medium, v * medium, { seed: 6521, octaves: 2, period: medium }) * 0.24 +
        fbm(u * grain, v * grain, { seed: 7621, octaves: 1, period: grain }) * 0.12 +
        texelNoise(i, j, 8731, size) * 0.22;
    }
  }

  standardise(heights);
  standardise(tones);

  for (let k = 0; k < heights.length; k++) {
    data[k * 2] = Math.round(heights[k] * 255);
    data[k * 2 + 1] = Math.round(tones[k] * 255);
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

  return texture;
}
