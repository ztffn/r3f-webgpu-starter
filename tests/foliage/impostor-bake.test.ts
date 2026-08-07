import assert from "node:assert/strict";
import test from "node:test";
import { alphaCoverage, buildCoveragePreservingMips } from "../../src/foliage/alphaMips.ts";
import {
  FOLIAGE_ALPHA_CUTOFF,
  FOLIAGE_IMPOSTOR_ALPHA_CUTOFF,
} from "../../src/foliage/foliageConfig.ts";
import { bakeImpostorAtlas } from "../../src/foliage/impostorBake.ts";
import { impostorBakeOptionsFor } from "../../src/foliage/impostorSource.ts";
import { SPECIES_BY_ID } from "../../src/foliage/species.ts";

// Small enough to keep the suite fast, large enough that a 64-texel tile can resolve the
// crown; every edge tile of the grid is a true horizon view regardless of n.
const BAKE = { spritesPerSide: 4, tileSize: 64, supersample: 2 } as const;

test("bake is deterministic — two runs are byte-identical", () => {
  const options = impostorBakeOptionsFor({ species: SPECIES_BY_ID.bush, variant: "B", ...BAKE });
  const first = bakeImpostorAtlas(options);
  const second = bakeImpostorAtlas(
    impostorBakeOptionsFor({ species: SPECIES_BY_ID.bush, variant: "B", ...BAKE })
  );
  assert.deepEqual(first.albedo.data, second.albedo.data);
  assert.deepEqual(first.normalDepth.data, second.normalDepth.data);
  assert.equal(first.radius, second.radius);
});

test("horizon views cover the crown rectangle like the geometric tiers do", () => {
  // The audit the plan requires for every tier: a far representation that quietly thins
  // hands free vision of a concealed target to whoever backs off (docs/08 §8 inv. 6).
  //
  // What "like" means here, measured (2026-08-07, 8x8 bake): the geometric LODs are
  // solved to 0.55 by an ANALYTIC estimate that averages over azimuth; the rendered
  // coverage of the same LOD 0 scatters around it BY VIEW (horizon min 0.45, median
  // ~0.52-0.54, max 0.64 across species). That scatter is the real silhouette varying
  // with angle — the near field shows exactly the same silhouette at that azimuth — so
  // faithfulness is the invariant, not per-view 0.55. The MEAN over horizon views must
  // track the solve target; the per-view floor only catches catastrophic thinning
  // (an empty tile, a broken projection), not honest silhouette variance.
  //
  // Only horizon tiles are audited: the crown's FRONTAL rectangle is the metric's frame,
  // and an elevated view projects the crown onto a tilted plane where that rectangle is
  // no longer what a horizontal ray crosses.
  const target = 0.55;
  const meanTolerance = 0.08;
  const floor = 0.38;
  for (const id of ["acacia", "bush", "scrub"] as const) {
    const options = impostorBakeOptionsFor({ species: SPECIES_BY_ID[id], variant: "B", ...BAKE });
    const bake = bakeImpostorAtlas(options);
    const n = BAKE.spritesPerSide;
    const horizonTiles = new Set<number>();
    for (let k = 0; k < n; k += 1) {
      horizonTiles.add(0 * n + k);
      horizonTiles.add((n - 1) * n + k);
      horizonTiles.add(k * n + 0);
      horizonTiles.add(k * n + (n - 1));
    }
    let sum = 0;
    for (const tileIndex of horizonTiles) {
      const coverage = bake.tileCoverage[tileIndex];
      assert.ok(Number.isFinite(coverage), `${id}: coverage measured for tile ${tileIndex}`);
      assert.ok(
        coverage >= floor,
        `${id} tile ${tileIndex} covers ${coverage.toFixed(3)} of the crown, floor ${floor}`
      );
      sum += coverage;
    }
    const mean = sum / horizonTiles.size;
    assert.ok(
      Math.abs(mean - target) <= meanTolerance,
      `${id} horizon mean ${mean.toFixed(3)} drifted from the ${target} solve target`
    );
  }
});

test("albedo atlas keeps its alpha-test coverage through the mip chain", () => {
  const options = impostorBakeOptionsFor({ species: SPECIES_BY_ID.acacia, variant: "B", ...BAKE });
  const bake = bakeImpostorAtlas(options);
  const levels = buildCoveragePreservingMips(bake.albedo, FOLIAGE_ALPHA_CUTOFF);
  const base = alphaCoverage(levels[0].data, FOLIAGE_ALPHA_CUTOFF);
  assert.ok(base > 0.05, `atlas has real coverage (${base.toFixed(3)})`);
  // The last two levels are a handful of texels and saturate; every level that can still
  // resolve the plants must track level 0 (same tolerance the leaf-texture test uses).
  for (let i = 1; i < levels.length - 2; i += 1) {
    const coverage = alphaCoverage(levels[i].data, FOLIAGE_ALPHA_CUTOFF);
    assert.ok(
      coverage >= base - 0.02,
      `level ${i} coverage ${coverage.toFixed(3)} thinned below base ${base.toFixed(3)}`
    );
  }
});

test("the runtime blend cutoff only widens the silhouette, never thins it", () => {
  const options = impostorBakeOptionsFor({ species: SPECIES_BY_ID.bush, variant: "B", ...BAKE });
  const bake = bakeImpostorAtlas(options);
  const atBake = alphaCoverage(bake.albedo.data, FOLIAGE_ALPHA_CUTOFF);
  const atRuntime = alphaCoverage(bake.albedo.data, FOLIAGE_IMPOSTOR_ALPHA_CUTOFF);
  assert.ok(FOLIAGE_IMPOSTOR_ALPHA_CUTOFF < FOLIAGE_ALPHA_CUTOFF);
  assert.ok(atRuntime >= atBake, "lower cutoff must pass at least as many texels");
});

test("covered texels carry unit-ish normals", () => {
  const options = impostorBakeOptionsFor({ species: SPECIES_BY_ID.acacia, variant: "B", ...BAKE });
  const bake = bakeImpostorAtlas(options);
  const { albedo, normalDepth } = bake;
  let covered = 0;
  for (let i = 0; i < albedo.data.length; i += 4) {
    if (albedo.data[i + 3] < FOLIAGE_ALPHA_CUTOFF * 255) continue;
    covered += 1;
    const nx = normalDepth.data[i] / 127.5 - 1;
    const ny = normalDepth.data[i + 1] / 127.5 - 1;
    const nz = normalDepth.data[i + 2] / 127.5 - 1;
    const length = Math.hypot(nx, ny, nz);
    assert.ok(length > 0.5 && length < 1.5, `normal length ${length.toFixed(3)} at texel ${i / 4}`);
  }
  assert.ok(covered > 0, "atlas has covered texels");
});
