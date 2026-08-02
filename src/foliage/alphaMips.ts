// Alpha-coverage-preserving mip generation for cutout foliage.
//
// WHY THIS EXISTS, and why it is not an optimisation
// A box filter averages alpha. Under an alpha TEST that silently deletes geometry: a
// leaf covering 40% of its texels at level 0 averages toward 0.4 alpha, drops below the
// 0.5 cutoff, and disappears entirely by level 2 or 3. The silhouette thins with
// distance and the bush becomes see-through — which for this project is not a cosmetic
// bug. Concealment is the product (docs/00 pillars 3 and 4), and docs/08 §8 invariant 6
// states the rule in its general form: THE RENDERER MUST NEVER CONCEAL LESS THAN THE
// GAMEPLAY FIELD SAYS IT DOES. A naive mip chain violates that rule at range, and the
// cheapest way for a player to trigger it is to back off and look — which is exactly the
// long-sightline case the game is defined around.
//
// The fix is standard and old (Castaño, "Computing Alpha Mipmaps", 2010; still an open
// request against Khronos' own KTX tooling, KTX-Software#486): after downsampling, scale
// each level's alpha so the fraction of texels passing the cutoff matches level 0.
//
// Pure arithmetic on typed arrays — no Three.js, no canvas, no DOM. That is deliberate:
// it makes the property testable in Node without a GPU, which is the only kind of
// verification this environment can actually perform (docs/08 §10).

export interface MipLevel {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Fraction of texels whose alpha passes `cutoff` after `scale` is applied. */
export function alphaCoverage(data: Uint8Array, cutoff: number, scale = 1): number {
  const threshold = cutoff * 255;
  let passed = 0;
  const texels = data.length / 4;
  for (let i = 0; i < texels; i += 1) {
    if (data[i * 4 + 3] * scale >= threshold) passed += 1;
  }
  return texels === 0 ? 0 : passed / texels;
}

/**
 * Box-downsample RGBA by 2, weighting colour by alpha.
 *
 * Alpha weighting is not cosmetic either: an unweighted average pulls the colour of a
 * transparent texel (usually black, because nothing authored it) into its neighbours,
 * and the result is the dark fringe that makes cutout foliage read as dirty at range.
 */
export function downsampleRGBA(level: MipLevel): MipLevel {
  const width = Math.max(1, level.width >> 1);
  const height = Math.max(1, level.height >> 1);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const sx = Math.min(level.width - 1, x * 2 + dx);
          const sy = Math.min(level.height - 1, y * 2 + dy);
          const i = (sy * level.width + sx) * 4;
          const sa = level.data[i + 3];
          r += level.data[i] * sa;
          g += level.data[i + 1] * sa;
          b += level.data[i + 2] * sa;
          a += sa;
          weight += sa;
        }
      }
      const o = (y * width + x) * 4;
      if (weight > 0) {
        out[o] = Math.round(r / weight);
        out[o + 1] = Math.round(g / weight);
        out[o + 2] = Math.round(b / weight);
      }
      out[o + 3] = Math.round(a / 4);
    }
  }
  return { data: out, width, height };
}

/**
 * Multiplier that brings this level's coverage back to `target`.
 *
 * Bisection rather than a closed form because coverage is a step function of the scale:
 * it changes only when some texel crosses the cutoff, so there is no derivative to
 * follow. Sixteen iterations resolves the scale to ~1e-4 of the [0, 4] bracket, which is
 * finer than the 1/255 quantisation of the alpha it is applied to.
 *
 * BIASED UPWARD ON PURPOSE, and this is the load-bearing part. Coverage can only land on
 * fractions the level's texel count can express, so an exact match often does not exist —
 * and once a level's texels have merged into a near-uniform alpha, the two reachable
 * answers are "nothing passes" and "everything passes". A nearest-match search picks
 * whichever is closer, which for a sparse canopy means picking NOTHING: the silhouette
 * vanishes at range. That is the fairness-violating direction (docs/08 §8 invariant 6 —
 * the renderer must never conceal less than the gameplay record says it does), so the
 * search prefers the smallest scale that reaches AT LEAST the target and only falls back
 * to the closest available answer when no such scale exists in the bracket.
 */
export function solveAlphaScale(
  data: Uint8Array,
  cutoff: number,
  target: number,
  iterations = 16
): number {
  let low = 0;
  let high = 4;
  let overshoot = Infinity;
  let closest = 1;
  let closestError = Infinity;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (low + high) * 0.5;
    const coverage = alphaCoverage(data, cutoff, mid);
    const error = Math.abs(coverage - target);
    if (error < closestError) {
      closestError = error;
      closest = mid;
    }
    if (coverage >= target) overshoot = Math.min(overshoot, mid);
    if (coverage < target) low = mid;
    else high = mid;
  }
  if (Number.isFinite(overshoot)) return overshoot;
  // Nothing in the bracket reaches the target. Take the most coverage available rather
  // than the closest number: over-concealing is a visual cost, under-concealing is a
  // competitive one.
  return alphaCoverage(data, cutoff, 4) > alphaCoverage(data, cutoff, closest) ? 4 : closest;
}

/**
 * A complete mip chain down to 1x1 whose alpha-test coverage tracks level 0.
 *
 * Level 0 is returned unmodified — it is ground truth, and rescaling it would move the
 * target the rest of the chain is trying to hit.
 */
export function buildCoveragePreservingMips(base: MipLevel, cutoff: number): MipLevel[] {
  const target = alphaCoverage(base.data, cutoff);
  const levels: MipLevel[] = [base];
  let current = base;
  while (current.width > 1 || current.height > 1) {
    current = downsampleRGBA(current);
    // A level with no coverage to preserve (a fully transparent region) must be left
    // alone: scaling zero alpha yields zero, and searching for a scale that cannot exist
    // would return the bracket's midpoint and invent coverage out of rounding noise.
    if (target > 0 && alphaCoverage(current.data, cutoff) !== target) {
      const scale = solveAlphaScale(current.data, cutoff, target);
      if (scale !== 1) {
        const scaled = new Uint8Array(current.data);
        for (let i = 3; i < scaled.length; i += 4) {
          scaled[i] = Math.min(255, Math.round(scaled[i] * scale));
        }
        current = { data: scaled, width: current.width, height: current.height };
      }
    }
    levels.push(current);
  }
  return levels;
}
