// Assembles the impostor bake's inputs for one species from the near field's own parts.
//
// The far tier must be a rendered image of exactly what the near field draws, so this
// module deliberately builds NOTHING itself: geometry comes from buildFoliageGeometry's
// LOD 0, the leaf alpha from createFoliageTexture, colours and cutoff from the same
// constants FoliageMaterial reads. It is the one place bake inputs are put together —
// the CLI baker and the Node tests both call it, so they cannot disagree.

import type { MipLevel } from "./alphaMips.ts";
import { FOLIAGE_ALPHA_CUTOFF, FOLIAGE_BARK_COLOR } from "./foliageConfig.ts";
import { buildFoliageGeometry, crownOf, type CardVariant } from "./foliageGeometry.ts";
import { createFoliageTexture } from "./foliageTexture.ts";
import type { ImpostorBakeOptions } from "./impostorBake.ts";
import type { Species } from "./species.ts";

export interface ImpostorSourceOptions {
  species: Species;
  variant: CardVariant;
  spritesPerSide: number;
  tileSize: number;
  supersample?: number;
}

/** Bake options for one species. The caller passes the result to `bakeImpostorAtlas`. */
export function impostorBakeOptionsFor(options: ImpostorSourceOptions): ImpostorBakeOptions {
  const { species, variant } = options;
  const build = buildFoliageGeometry(species, variant, 0);
  const geometry = build.geometry;
  const mesh = {
    position: new Float32Array(geometry.getAttribute("position").array as Float32Array),
    normal: new Float32Array(geometry.getAttribute("normal").array as Float32Array),
    uv: new Float32Array(geometry.getAttribute("uv").array as Float32Array),
    // `leaf` survived packing as its own attribute (foliageGeometry's packing note).
    leaf: new Float32Array(geometry.getAttribute("leaf").array as Float32Array),
  };
  geometry.dispose();

  const foliage = createFoliageTexture();
  const image = foliage.texture.image as { data: Uint8Array; width: number; height: number };
  const leafTexture: MipLevel = { data: image.data, width: image.width, height: image.height };
  foliage.texture.dispose();

  const crown = crownOf(species);
  return {
    mesh,
    leafTexture,
    leafColor: species.foliageTint,
    barkColor: FOLIAGE_BARK_COLOR,
    alphaCutoff: FOLIAGE_ALPHA_CUTOFF,
    spritesPerSide: options.spritesPerSide,
    tileSize: options.tileSize,
    supersample: options.supersample,
    crown: { radiusMetres: crown.radius, baseY: crown.baseY, topY: crown.topY },
  };
}
