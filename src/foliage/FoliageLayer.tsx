// Composition root for the vegetation layer: field, assets, renderer and ballistic proxy.
//
// One component so the scene's diff is one line and the layer can be switched off
// entirely with `?foliage=0` — which matters more than it sounds. Every existing frame
// time, screenshot and grass measurement in docs/07 and docs/09 was taken without this
// layer, and a subsystem that cannot be measured against its own absence at the same pose
// cannot be attributed a cost (docs/03 §4.4, and the reason `?grasscap=` exists).

import { useEffect, useMemo, useRef } from "react";
import type * as THREE from "three/webgpu";
import { FoliageCells, type FoliageStats } from "./FoliageCells.tsx";
import { createFoliageTexture } from "./foliageTexture.ts";
import { createFoliageUniforms } from "./FoliageMaterial.ts";
import type { FoliageAlphaMode } from "./FoliageMaterial.ts";
import type { CardVariant } from "./foliageGeometry.ts";
import { VegetationField, type VegetationTerrain } from "./VegetationField.ts";
import { VegetationWorldQuery } from "./VegetationWorldQuery.ts";
import { FOLIAGE_VIEW_RADIUS_METRES } from "./foliageConfig.ts";
import type { CompositeWorldQuery } from "../fps/core/WorldQuery.ts";
import type { Atmosphere } from "../df2/atmosphere.ts";
import { BENCH, publishFoliage } from "../df2/bench.ts";

function parseVariant(value: string | undefined): CardVariant {
  const upper = (value ?? "").toUpperCase();
  return upper === "A" || upper === "B" || upper === "C" || upper === "D" ? upper : "B";
}

function parseAlphaMode(value: string | undefined): FoliageAlphaMode {
  switch ((value ?? "").toLowerCase()) {
    case "a2c":
    case "mask-a2c":
      return "mask-a2c";
    case "hash":
      return "hash";
    case "blend":
      return "blend";
    default:
      return "mask";
  }
}

export interface FoliageLayerProps {
  terrain: VegetationTerrain;
  /** Grade and fog, applied after lighting — foliage is the first lit scene surface. */
  atmosphere: Atmosphere;
  /**
   * Live density multiplier. Applied to the existing field rather than rebuilding it, so
   * dragging the slider costs a budgeted cell refill instead of 500 new meshes.
   */
  density?: number;
  /**
   * Spawner reach in METRES, and the spacing between candidate placement sites.
   *
   * Both REBUILD, unlike density: spacing changes `placementGrid` and therefore every
   * bucket's buffer capacity, and radius changes how many buckets exist. So they arrive
   * as props that reconstruct the field and the cell window, and the pipeline warm-up
   * runs again — which is why the panel commits them on release rather than per tick.
   *
   * Spacing is the real lever on plant COUNT. Density saturates, because a site yields at
   * most one plant, so plants per area is bounded by sites per area — 1/spacing².
   */
  radiusMetres?: number;
  siteSpacing?: number;
  /** Registered so trunks stop bullets; leaves never do. */
  worldQuery?: CompositeWorldQuery | null;
  waterHeight?: number;
  onStats?: (stats: FoliageStats) => void;
}

export function FoliageLayer({
  terrain,
  atmosphere,
  density,
  radiusMetres: radiusOverride,
  siteSpacing,
  worldQuery,
  waterHeight,
  onStats,
}: FoliageLayerProps) {
  const variant = parseVariant(BENCH.foliageVariant);
  const alphaMode = parseAlphaMode(BENCH.foliageAlpha);
  const radiusMetres = radiusOverride ?? BENCH.foliageRadius ?? FOLIAGE_VIEW_RADIUS_METRES;

  const field = useMemo(
    () =>
      new VegetationField({
        terrain,
        cellSize: BENCH.foliageCell,
        // No `density` here: the effect below owns it, and DF2Scene already seeds its
        // state from `BENCH.foliageDensity`. Passing it twice meant the constructor value
        // was overwritten on the next tick and could silently disagree with the seed.
        siteSpacing,
        waterHeight,
      }),
    [terrain, siteSpacing, waterHeight]
  );

  const assets = useMemo(() => {
    const foliage = createFoliageTexture();
    return { foliage, uniforms: createFoliageUniforms() };
  }, []);

  useEffect(() => () => assets.foliage.texture.dispose(), [assets]);

  // Not in the field's constructor options: rebuilding the field would rebuild every
  // bucket mesh and re-run the pipeline warm-up on every drag.
  useEffect(() => {
    if (density !== undefined) field.setDensity(density);
  }, [field, density]);

  useEffect(() => {
    if (!worldQuery) return;
    return worldQuery.addSource(new VegetationWorldQuery(field));
  }, [worldQuery, field]);

  const lastStats = useRef<FoliageStats | null>(null);
  const handleStats = useMemo(
    () => (stats: FoliageStats) => {
      lastStats.current = stats;
      publishFoliage({
        variant,
        alphaMode,
        cellSize: field.cellSize,
        radiusMetres,
        visibleBuckets: stats.visibleBuckets,
        visibleInstances: stats.visibleInstances,
        trianglesIfAllDrawn: stats.trianglesIfAllDrawn,
        cellsCached: stats.cellsCached,
        pendingBuckets: stats.pendingBuckets,
        alphaOccupancy: assets.foliage.alphaOccupancy,
        levelCoverage: assets.foliage.levelCoverage,
      });
      onStats?.(stats);
    },
    [variant, alphaMode, field, radiusMetres, assets, onStats]
  );

  return (
    <FoliageCells
      field={field}
      texture={assets.foliage.texture as unknown as THREE.Texture}
      uniforms={assets.uniforms}
      atmosphere={atmosphere}
      variant={variant}
      alphaMode={alphaMode}
      radiusMetres={radiusMetres}
      onStats={handleStats}
    />
  );
}
