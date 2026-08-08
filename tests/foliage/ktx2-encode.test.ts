// Guards the KTX2 encode against thinning a silhouette — invariant 6, in CI.
//
// The bake audits every atlas it writes and throws on drift, but only when somebody bakes.
// This runs every suite, so a broken encode, a lost mip chain, a `--genmipmap` creeping
// back in, or a downgrade to ETC1S fails here rather than in a screenshot later.
//
// It DOES discriminate the format, and that is verified by mutation rather than asserted:
// swapping `uastc` for `etc1s` in ktx2.mjs takes level 0 from 0.000% of texels crossing the
// alpha test to 0.698%, tripping the bound below by 7x. The evidence that rejected ETC1S is
// still the real 2040² acacia atlas (0.569%, plan v2 §5.4d); this fixture reproduces that
// signature at 384² — see `silhouette` for the three properties that made it possible.
//
// Skips loudly when KTX-Software is absent: the toolchain is a bake dependency, not a
// runtime one, and a silent pass would be a false claim of coverage.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { alphaCoverage, buildCoveragePreservingMips, type MipLevel } from "../../src/foliage/alphaMips.ts";
import { FOLIAGE_ALPHA_CUTOFF, FOLIAGE_IMPOSTOR_ALPHA_CUTOFF } from "../../src/foliage/foliageConfig.ts";
import { encodeKtx2, ktx2Alpha } from "../../tools/vegetation/ktx2.mjs";

function hasToolchain(): boolean {
  try {
    execFileSync("toktx", ["--version"], { stdio: "ignore" });
    execFileSync("ktx", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Tiles across the fixture, and leaf blobs scattered into each one. */
const TILES = 24;
const BLOBS = 12;

/**
 * Alpha samples per axis before the box reduce. TWO, because that is what the bake uses
 * (`impostorBake.ts`, `options.supersample ?? 2`) and the exact value is load-bearing —
 * see property 1 below.
 */
const SUPERSAMPLE = 2;

/**
 * A miniature impostor atlas: a grid of tiles holding scattered leaf blobs, half of them
 * round and half thin slivers, rendered supersampled and box-reduced the way the bake
 * does — so edge texels carry FRACTIONAL alpha rather than 0 or 255.
 *
 * THREE PROPERTIES MAKE THIS DISCRIMINATE UASTC FROM ETC1S, each of which was measured,
 * and two of which cost a fixture that proved nothing:
 *
 * 1. FRACTIONAL EDGE ALPHA, at the bake's own supersample rate. Two earlier fixtures used
 *    hard binary alpha and both PASSED under ETC1S: with only 0 and 255 in the channel,
 *    even a coarsely quantised encoder lands on the right side of a 0.4 cutoff. Box-
 *    reducing 2x2 coverage samples puts five alpha values in the channel, three of them
 *    interior, and the middle one sits astride the cutoff. Note the rate matters in BOTH
 *    directions: at 4x4 samples UASTC itself starts flipping texels (0.045%), because 17
 *    alpha levels no longer land exactly on values it can represent. Matching the bake is
 *    what makes the fixture's UASTC number reproduce the real atlas's 0.000%.
 *
 * 2. HIGH-FREQUENCY ALPHA. ETC1S codes alpha as a separate slice against a global,
 *    heavily quantised codebook, so it degrades where neighbouring 4x4 blocks disagree.
 *    576 tiles of overlapping slivers is that; one smooth ring was not.
 *
 * 3. LOW-FREQUENCY RGB. This one is counter-intuitive and it is why an earlier fixture
 *    read as a wash. UASTC is fixed-rate and trades colour bits against alpha bits inside
 *    one block, so full-range RGB noise wrecks UASTC's ALPHA — 0.494% against ETC1S's
 *    0.562%, a difference of nothing. Replacing the noise with a smooth gradient drops
 *    UASTC to 0.000% and leaves ETC1S at 0.698%, because ETC1S was never spending its
 *    alpha budget on colour in the first place. A real atlas is smooth within a leaf.
 *
 * The gradient also keeps the base level compressing larger than its own first mip. Below
 * that, `toktx` writes a level index that is not sorted largest-to-smallest, which
 * violates the KTX2 spec and `ktx extract` refuses to read it.
 */
function silhouette(size: number): MipLevel {
  const data = new Uint8Array(size * size * 4);
  const tile = size / TILES;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tx = Math.floor(x / tile);
      const ty = Math.floor(y / tile);
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const lx = x + (sx + 0.5) / SUPERSAMPLE - tx * tile;
          const ly = y + (sy + 0.5) / SUPERSAMPLE - ty * tile;
          let covered = false;
          // Blobs placed from a hash of the tile index so the pattern differs per tile the
          // way baked views do, and deterministically so a failure reproduces exactly.
          for (let b = 0; b < BLOBS && !covered; b += 1) {
            const h = ((tx * 73856093) ^ (ty * 19349663) ^ (b * 83492791)) >>> 0;
            const cx = ((h & 0xff) / 255) * tile;
            const cy = (((h >>> 8) & 0xff) / 255) * tile;
            const sliver = b % 2 === 1;
            const rx = tile * (0.07 + ((h >>> 16) & 0x1f) / 255) * 0.9 * (sliver ? 0.8 : 1);
            const ry = rx * (sliver ? 0.2 : 0.6) * (0.4 + ((h >>> 24) & 0x0f) / 15);
            const angle = (((h >>> 12) & 0x3f) / 64) * Math.PI;
            const ca = Math.cos(angle);
            const sa = Math.sin(angle);
            const ox = lx - cx;
            const oy = ly - cy;
            const dx = (ox * ca + oy * sa) / rx;
            const dy = (-ox * sa + oy * ca) / ry;
            if (dx * dx + dy * dy <= 1) covered = true;
          }
          if (covered) hits += 1;
        }
      }
      const i = (y * size + x) * 4;
      data[i] = 40 + Math.round((x / size) * 60);
      data[i + 1] = 90 + Math.round((y / size) * 60);
      data[i + 2] = 30 + Math.round(((x + y) / (2 * size)) * 40);
      data[i + 3] = Math.round((hits / samples) * 255);
    }
  }
  return { data, width: size, height: size };
}

const toolchain = hasToolchain();

test(
  "KTX2 encode preserves the silhouette at the cutoff the far tier tests at",
  { skip: toolchain ? false : "KTX-Software not on PATH (brew install ktx); bake-only dependency" },
  async () => {
    const base = silhouette(384);
    const levels = buildCoveragePreservingMips(base, FOLIAGE_ALPHA_CUTOFF);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "df2-ktx2-test-"));
    try {
      const out = path.join(dir, "atlas.ktx2");
      const bytes = await encodeKtx2(out, levels);
      assert.ok(bytes > 0, "encoder wrote a file");

      const shipped = await ktx2Alpha(out, base.width, base.height);
      const source = alphaCoverage(base.data, FOLIAGE_IMPOSTOR_ALPHA_CUTOFF);
      const after = alphaCoverage(shipped.data, FOLIAGE_IMPOSTOR_ALPHA_CUTOFF);

      // THINNING is the failure, not any difference: concealing less than the source is
      // the fairness-violating direction (docs/08 §8 invariant 6). Concealing marginally
      // more is a visual cost, not a competitive one, so the bound is one-sided-ish and
      // matches the threshold the bake itself throws at.
      //
      // This one does NOT catch a format downgrade on its own — ETC1S thins by 0.0013
      // here, well inside the bound. Total area is the weaker question; the placement
      // check below is the one that separates the formats.
      assert.ok(
        after - source > -0.005,
        `encoding thinned coverage ${source.toFixed(4)} -> ${after.toFixed(4)}`
      );

      // And the silhouette must not merely have the same AREA — it has to be in the same
      // place. A block encoder that eroded one edge and grew another would pass a coverage
      // test alone, and that is exactly ETC1S's failure: it keeps the area and moves the
      // edges.
      let flipped = 0;
      const threshold = FOLIAGE_IMPOSTOR_ALPHA_CUTOFF * 255;
      const texels = base.data.length / 4;
      for (let i = 0; i < texels; i += 1) {
        const a = base.data[i * 4 + 3] >= threshold;
        const b = shipped.data[i * 4 + 3] >= threshold;
        if (a !== b) flipped += 1;
      }
      // 0.1%, sitting in a gap two orders of magnitude wide: UASTC flips ZERO texels on
      // this fixture and ETC1S flips 0.698%. Deliberately not tightened onto the UASTC
      // number — the bound exists to catch a format downgrade, a lost alpha channel or a
      // shifted image, not to pin one encoder build's exact output.
      assert.ok(
        flipped / texels < 0.001,
        `${((flipped / texels) * 100).toFixed(3)}% of texels crossed the alpha test`
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

test("the mip chain the encoder is handed does not thin either", () => {
  const base = silhouette(384);
  const levels = buildCoveragePreservingMips(base, FOLIAGE_ALPHA_CUTOFF);
  const target = alphaCoverage(base.data, FOLIAGE_ALPHA_CUTOFF);
  assert.ok(levels.length > 1, "chain has levels below the base");
  // Only the levels with enough texels to express the target: at 4x4 and below, coverage
  // quantises so coarsely that the solve cannot land near it, and the renderer is not
  // sampling those levels at any distance a player fights at.
  for (const level of levels.filter((l) => l.width >= 8)) {
    const coverage = alphaCoverage(level.data, FOLIAGE_ALPHA_CUTOFF);
    assert.ok(
      coverage >= target - 0.02,
      `level ${level.width}x${level.height} thinned to ${coverage.toFixed(3)} from ${target.toFixed(3)}`
    );
  }
});
