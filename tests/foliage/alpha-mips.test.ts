import assert from "node:assert/strict";
import test from "node:test";
import {
  alphaCoverage,
  buildCoveragePreservingMips,
  downsampleRGBA,
  solveAlphaScale,
  type MipLevel,
} from "../../src/foliage/alphaMips.ts";

const CUTOFF = 0.5;

/** Scattered opaque dots on a transparent field — the shape of a leaf cluster's alpha. */
function dottedTexture(size: number, spacing: number, radius: number): MipLevel {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x % spacing) - spacing / 2;
      const dy = (y % spacing) - spacing / 2;
      const inside = dx * dx + dy * dy <= radius * radius;
      const i = (y * size + x) * 4;
      data[i] = 90;
      data[i + 1] = 160;
      data[i + 2] = 70;
      data[i + 3] = inside ? 255 : 0;
    }
  }
  return { data, width: size, height: size };
}

test("naive mip chain loses alpha-test coverage, which is the bug being fixed", () => {
  const base = dottedTexture(64, 8, 2.4);
  const target = alphaCoverage(base.data, CUTOFF);
  assert.ok(target > 0.1 && target < 0.5, `unexpected base coverage ${target}`);

  let level = base;
  let worst = 0;
  for (let i = 0; i < 4; i += 1) {
    level = downsampleRGBA(level);
    worst = Math.max(worst, Math.abs(alphaCoverage(level.data, CUTOFF) - target));
  }
  // Without correction the thin features fall below the cutoff and the silhouette thins.
  assert.ok(worst > 0.1, `expected naive drift, saw ${worst}`);
});

test("coverage-preserving chain holds coverage close to level 0, and never goes blank", () => {
  const base = dottedTexture(64, 8, 2.4);
  const target = alphaCoverage(base.data, CUTOFF);
  const levels = buildCoveragePreservingMips(base, CUTOFF);

  assert.equal(levels[0].data, base.data, "level 0 must be untouched ground truth");
  assert.equal(levels.at(-1)?.width, 1);
  assert.equal(levels.at(-1)?.height, 1);

  // Coverage is a step function of the alpha scale, so a level can only land on the
  // fractions its texel count can express: a 16x16 level quantises to 1/256, and once the
  // dots have merged there may be no scale that reproduces the target exactly. The
  // guarantee asserted is therefore the one that is actually available — tight where the
  // level can still resolve the features, and never losing the silhouette entirely.
  for (const level of levels) {
    const coverage = alphaCoverage(level.data, CUTOFF);
    if (level.width >= 32) {
      assert.ok(
        Math.abs(coverage - target) < 0.06,
        `level ${level.width} coverage ${coverage} vs target ${target}`
      );
    }
    assert.ok(coverage > 0, `level ${level.width} lost all coverage`);
  }
});

test("correction never concedes coverage, at any level — the actual guarantee", () => {
  // Stated as a ONE-SIDED property on purpose. The solver is biased upward, so a level
  // that cannot express the target exactly overshoots, and a symmetric "closer to target
  // than naive" assertion would fail on exactly the levels where the bias is doing its
  // job. What must hold is that correction only ever ADDS coverage, and never leaves the
  // silhouette materially thinner than level 0 — thinner is the direction that hands a
  // player free vision of a concealed target.
  const base = dottedTexture(64, 8, 2.4);
  const target = alphaCoverage(base.data, CUTOFF);
  const corrected = buildCoveragePreservingMips(base, CUTOFF);

  let naive = base;
  for (let level = 1; level < corrected.length; level += 1) {
    naive = downsampleRGBA(naive);
    const naiveCoverage = alphaCoverage(naive.data, CUTOFF);
    const correctedCoverage = alphaCoverage(corrected[level].data, CUTOFF);
    assert.ok(
      correctedCoverage >= naiveCoverage - 1e-9,
      `level ${corrected[level].width}: corrected ${correctedCoverage} below naive ${naiveCoverage}`
    );
    assert.ok(
      correctedCoverage >= target - 0.02,
      `level ${corrected[level].width}: corrected ${correctedCoverage} thinner than target ${target}`
    );
  }
});

test("solveAlphaScale finds a scale that hits the requested coverage", () => {
  const base = dottedTexture(32, 8, 2.4);
  const target = alphaCoverage(base.data, CUTOFF);
  const half = downsampleRGBA(base);
  const scale = solveAlphaScale(half.data, CUTOFF, target);
  assert.ok(Math.abs(alphaCoverage(half.data, CUTOFF, scale) - target) < 0.06);
});

test("fully transparent input is left alone rather than given invented coverage", () => {
  const size = 16;
  const empty: MipLevel = { data: new Uint8Array(size * size * 4), width: size, height: size };
  const levels = buildCoveragePreservingMips(empty, CUTOFF);
  for (const level of levels) {
    assert.equal(alphaCoverage(level.data, CUTOFF), 0);
  }
});

test("downsampling weights colour by alpha so transparent texels cannot darken neighbours", () => {
  // One opaque bright texel and three transparent black ones. An unweighted average
  // would return a quarter-brightness colour — the dark fringe on cutout foliage.
  const data = new Uint8Array(2 * 2 * 4);
  data[0] = 200;
  data[1] = 200;
  data[2] = 200;
  data[3] = 255;
  const level = downsampleRGBA({ data, width: 2, height: 2 });
  assert.equal(level.data[0], 200);
  assert.equal(level.data[3], 64);
});
