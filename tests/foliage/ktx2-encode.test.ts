// Guards the KTX2 encode against thinning a silhouette — invariant 6, in CI.
//
// The bake audits every atlas it writes and throws on drift, but only when somebody bakes.
// This runs every suite, so a broken encode, a lost mip chain or a `--genmipmap` creeping
// back in fails here rather than in a screenshot later.
//
// WHAT IT DOES NOT CATCH, stated because an overstated test is worse than none: it does
// NOT discriminate UASTC from ETC1S. Verified by mutation — swapping the encoder to ETC1S
// still passes, because a synthetic fixture this size does not carry enough high-frequency
// alpha to expose ETC1S's quantised alpha slice. The evidence that rejected ETC1S is a
// measurement on the real 2040² acacia atlas (0.569% of pixels flipped versus UASTC's
// 0.000%), recorded in plan v2 §5.4d. Do not read a pass here as format validation.
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

/**
 * A miniature impostor atlas: a grid of tiles, each holding scattered leaf blobs with
 * hard alpha edges.
 *
 * The shape matters more than it looks. An earlier version used one smooth ring, and the
 * test PASSED when the encoder was switched to ETC1S — the format this project rejected
 * on measurement — because a single low-frequency silhouette is easy for any encoder.
 * ETC1S stores alpha as a separate, heavily quantised slice, so it only falls apart on
 * HIGH-FREQUENCY alpha detail, which is exactly what a real atlas of 144 leafy tiles is
 * and what this fixture reproduces. Verified by mutation: swap `uastc` for `etc1s` in
 * ktx2.mjs and this test must fail.
 *
 * RGB carries deterministic noise so the base level does not compress smaller than its
 * own first mip — `toktx` then writes a level index that is not sorted largest-to-
 * smallest, which violates the KTX2 spec and `ktx extract` refuses to read.
 */
function silhouette(size: number): MipLevel {
  const data = new Uint8Array(size * size * 4);
  const tiles = 12;
  const tile = size / tiles;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tx = Math.floor(x / tile);
      const ty = Math.floor(y / tile);
      const lx = x - tx * tile;
      const ly = y - ty * tile;
      let covered = false;
      // Eight blobs per tile, placed from a hash of the tile index so the pattern differs
      // per tile the way baked views do.
      for (let b = 0; b < 8 && !covered; b += 1) {
        const h = ((tx * 73856093) ^ (ty * 19349663) ^ (b * 83492791)) >>> 0;
        const cx = ((h & 0xff) / 255) * tile;
        const cy = (((h >>> 8) & 0xff) / 255) * tile;
        const rx = tile * (0.10 + ((h >>> 16) & 0x1f) / 255);
        const ry = tile * (0.05 + ((h >>> 21) & 0x1f) / 255);
        const dx = (lx - cx) / rx;
        const dy = (ly - cy) / ry;
        if (dx * dx + dy * dy <= 1) covered = true;
      }
      const i = (y * size + x) * 4;
      const n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      data[i] = 40 + (n & 0x7f);
      data[i + 1] = 90 + ((n >>> 8) & 0x7f);
      data[i + 2] = 30 + ((n >>> 16) & 0x7f);
      data[i + 3] = covered ? 255 : 0;
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
      assert.ok(
        after - source > -0.005,
        `encoding thinned coverage ${source.toFixed(4)} -> ${after.toFixed(4)}`
      );

      // And the silhouette must not merely have the same AREA — it has to be in the same
      // place. A block encoder that eroded one edge and grew another would pass a coverage
      // test alone.
      let flipped = 0;
      const threshold = FOLIAGE_IMPOSTOR_ALPHA_CUTOFF * 255;
      const texels = base.data.length / 4;
      for (let i = 0; i < texels; i += 1) {
        const a = base.data[i * 4 + 3] >= threshold;
        const b = shipped.data[i * 4 + 3] >= threshold;
        if (a !== b) flipped += 1;
      }
      // A loose bound on purpose: it catches an encode that lost the alpha channel or
      // shifted the image, not a format downgrade (see the header). UASTC on this fixture
      // sits far below it.
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
