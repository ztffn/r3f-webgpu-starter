import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFoliageGeometry,
  CARD_VARIANTS,
  FOLIAGE_IMPOSTOR_LOD,
  FOLIAGE_LOD_COUNT,
} from "../../src/foliage/foliageGeometry.ts";
import { SPECIES } from "../../src/foliage/species.ts";

test("every variant and LOD builds a non-empty, consistent mesh", () => {
  for (const species of SPECIES) {
    for (const variant of CARD_VARIANTS) {
      for (let lod = 0; lod < FOLIAGE_LOD_COUNT; lod += 1) {
        const build = buildFoliageGeometry(species, variant, lod);
        const position = build.geometry.getAttribute("position");
        assert.ok(position.count > 0, `${species.id} ${variant} lod${lod} is empty`);
        assert.equal(position.count % 3, 0, "non-indexed triangles");
        assert.equal(position.count / 3, build.triangleCount);
        // aCard packs (card.xy, sway, billboard) — four separate attributes before the
        // WebGPU vertex-buffer limit forced them into one (foliageGeometry).
        for (const name of ["normal", "uv", "aCard", "leaf"]) {
          assert.equal(
            build.geometry.getAttribute(name).count,
            position.count,
            `${name} is not per-vertex on ${species.id} ${variant} lod${lod}`
          );
        }
        build.geometry.dispose();
      }
    }
  }
});

test("coarser LODs keep the concealment envelope", () => {
  // docs/08 §8 invariant 6, applied to vegetation: a distant LOD that quietly becomes
  // more transparent hands free vision of a covered target to whoever triggers it — and
  // backing off to trigger it costs nothing. Cards are dropped going down the chain and
  // the survivors grow to compensate; this is the assertion that they actually do.
  for (const species of SPECIES) {
    for (const variant of CARD_VARIANTS) {
      const reference = buildFoliageGeometry(species, variant, 0);
      for (let lod = 1; lod < FOLIAGE_LOD_COUNT; lod += 1) {
        const build = buildFoliageGeometry(species, variant, lod);
        const ratio = build.blockingFraction / reference.blockingFraction;
        assert.ok(
          ratio > 0.85,
          `${species.id} ${variant} lod${lod} conceals ${(ratio * 100).toFixed(0)}% of LOD 0`
        );
        build.geometry.dispose();
      }
      reference.geometry.dispose();
    }
  }
});

test("all four variants block the same share of rays, so their cost is comparable", () => {
  // The experiment is "same plant, four constructions, which is cheaper". If the
  // constructions do not conceal equally, the cheapest is just the thinnest bush and the
  // measurement answers nothing. Before this was solved, D blocked 0.27 against A's 0.52.
  for (const species of SPECIES) {
    const blocking = CARD_VARIANTS.map(
      (variant) => buildFoliageGeometry(species, variant, 0).blockingFraction
    );
    const spread = Math.max(...blocking) - Math.min(...blocking);
    assert.ok(spread < 0.02, `${species.id} variants block ${blocking.map((b) => b.toFixed(2))}`);
  }
});

test("the variants still differ in triangle count, which is the axis under test", () => {
  const species = SPECIES.find((s) => s.id === "bush");
  assert.ok(species);
  const triangles = CARD_VARIANTS.map(
    (variant) => buildFoliageGeometry(species, variant, 0).triangleCount
  );
  assert.ok(
    Math.max(...triangles) >= Math.min(...triangles) * 3,
    `variants collapsed onto one cost point: ${triangles.join(", ")}`
  );
});

test("triangle count falls monotonically across the geometric LODs", () => {
  for (const species of SPECIES) {
    for (const variant of CARD_VARIANTS) {
      const counts = [0, 1, 2].map(
        (lod) => buildFoliageGeometry(species, variant, lod).triangleCount
      );
      assert.ok(
        counts[0] >= counts[1] && counts[1] >= counts[2],
        `${species.id} ${variant} triangles ${counts.join(" -> ")}`
      );
    }
  }
});

test("the impostor is one card and carries a usable billboard offset", () => {
  const build = buildFoliageGeometry(SPECIES[0], "B", FOLIAGE_IMPOSTOR_LOD);
  assert.equal(build.cardCount, 1);
  // Packed: aCard is (card.x, card.y, sway, billboard), so billboard is W and the card
  // offset is XY of the same attribute.
  const cardData = build.geometry.getAttribute("aCard");
  for (let i = 0; i < cardData.count; i += 1) {
    assert.equal(cardData.getW(i), 1);
  }
  // The offsets must be real: a degenerate card would vanish if the billboard branch in
  // the shader were ever bypassed, and a vegetation system that silently disappears is
  // the worst failure available to it.
  let widest = 0;
  for (let i = 0; i < cardData.count; i += 1)
    widest = Math.max(widest, Math.abs(cardData.getX(i)));
  assert.ok(widest > 0.1, "impostor card offsets are degenerate");
});

test("variants differ in card count and card size, which is the point of having four", () => {
  const species = SPECIES[1];
  const builds = CARD_VARIANTS.map((variant) => buildFoliageGeometry(species, variant, 0));
  const cards = builds.map((build) => build.cardCount);
  assert.ok(cards[0] < cards[1], "A must be the sparse-large-card variant");
  assert.ok(cards[3] > cards[1], "D must be the many-small-cards variant");
  for (const build of builds) build.geometry.dispose();
});

test("only the trunk-bearing species emits non-swaying geometry with a bark flag", () => {
  for (const species of SPECIES) {
    const build = buildFoliageGeometry(species, "A", 0);
    const leaf = build.geometry.getAttribute("leaf");
    let bark = 0;
    for (let i = 0; i < leaf.count; i += 1) if (leaf.getX(i) === 0) bark += 1;
    if (species.trunk) assert.ok(bark > 0, `${species.id} should have a trunk`);
    else assert.equal(bark, 0, `${species.id} has no trunk in variant A`);
    build.geometry.dispose();
  }
});

test("a trunk vertex never sways, so the ballistic proxy cannot drift from the mesh", () => {
  const species = SPECIES.find((s) => s.trunk);
  assert.ok(species);
  const build = buildFoliageGeometry(species, "C", 0);
  const leaf = build.geometry.getAttribute("leaf");
  // Sway is Z of the packed aCard attribute.
  const cardData = build.geometry.getAttribute("aCard");
  for (let i = 0; i < leaf.count; i += 1) {
    if (leaf.getX(i) === 0) assert.equal(cardData.getZ(i), 0);
  }
});
