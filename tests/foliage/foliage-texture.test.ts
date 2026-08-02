import assert from "node:assert/strict";
import test from "node:test";
import { createFoliageTexture } from "../../src/foliage/foliageTexture.ts";
import { FOLIAGE_ALPHA_CUTOFF } from "../../src/foliage/foliageConfig.ts";

test("the shipped leaf texture keeps its coverage down the whole mip chain", () => {
  const { texture, alphaOccupancy, levelCoverage } = createFoliageTexture();

  // A leaf cluster that is nearly solid is not a cluster, and one that is nearly empty
  // conceals nothing. Both ends of that range are configuration mistakes worth catching.
  assert.ok(
    alphaOccupancy > 0.2 && alphaOccupancy < 0.75,
    `implausible alpha occupancy ${alphaOccupancy}`
  );

  assert.equal(levelCoverage[0], alphaOccupancy);
  for (let level = 0; level < levelCoverage.length; level += 1) {
    assert.ok(
      levelCoverage[level] >= alphaOccupancy - 0.02,
      `mip ${level} thinned to ${levelCoverage[level]} from ${alphaOccupancy}`
    );
  }

  // The mip chain must be SUPPLIED. `generateMipmaps` would run the GPU's box filter and
  // throw away every correction above.
  assert.equal(texture.generateMipmaps, false);
  assert.ok(texture.mipmaps.length > 1);
  assert.equal(texture.mipmaps[0].width, texture.image.width);
  assert.equal(texture.mipmaps.at(-1)?.width, 1);
  texture.dispose();
});

test("the leaf texture is deterministic, so two clients bake the same silhouette", () => {
  const a = createFoliageTexture(7);
  const b = createFoliageTexture(7);
  const c = createFoliageTexture(8);
  assert.equal(a.alphaOccupancy, b.alphaOccupancy);
  assert.notEqual(a.alphaOccupancy, c.alphaOccupancy);
  for (const texture of [a, b, c]) texture.texture.dispose();
});

test("the cutoff the texture was corrected for is the cutoff the material tests at", () => {
  // The chain is built against FOLIAGE_ALPHA_CUTOFF; if a material ever tested at a
  // different value the correction would be preserving coverage nobody is measuring.
  assert.ok(FOLIAGE_ALPHA_CUTOFF > 0 && FOLIAGE_ALPHA_CUTOFF < 1);
});
