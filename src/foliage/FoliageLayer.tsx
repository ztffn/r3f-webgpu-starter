// Composition root for the vegetation layer: field, assets, renderer and ballistic proxy.
//
// One component so the scene's diff is one line and the layer can be switched off
// entirely with `?foliage=0` — which matters more than it sounds. Every existing frame
// time, screenshot and grass measurement in docs/07 and docs/09 was taken without this
// layer, and a subsystem that cannot be measured against its own absence at the same pose
// cannot be attributed a cost (docs/03 §4.4, and the reason `?grasscap=` exists).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import type * as THREE from "three/webgpu";
import { FoliageCells, type FoliageStats } from "./FoliageCells.tsx";
import { createFoliageTexture } from "./foliageTexture.ts";
import { createFoliageUniforms } from "./FoliageMaterial.ts";
import type { FoliageAlphaMode } from "./FoliageMaterial.ts";
import type { CardVariant } from "./foliageGeometry.ts";
import {
  FarFoliageCells,
  type FarFoliageLights,
  type FarFoliageStats,
} from "./FarFoliageCells.tsx";
import { loadImpostorAtlases, type ImpostorAtlases } from "./impostorAtlas.ts";
import { loadTreePrototypes, type TreePrototypes } from "./treePrototypes.ts";
import { VegetationField, type VegetationTerrain } from "./VegetationField.ts";
import { VegetationWorldQuery } from "./VegetationWorldQuery.ts";
import { foliageHandoffBand } from "./foliageConfig.ts";
import { FoliageOverdrawProbe } from "./FoliageOverdrawProbe.tsx";
import {
  createFoliageDebugControls,
  type FoliageDebugControls,
} from "./foliageDebug.ts";
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
   *
   * REQUIRED, not defaulted here. The scene already resolves `?foliageradius=` into the
   * state it drives this with, and resolving the same URL flag in two places is what let
   * `density` disagree with its own seed (see the field's construction below).
   */
  radiusMetres: number;
  siteSpacing?: number;
  /**
   * Outer reach of the far impostor ring, metres; 0 disables it. The ring only exists
   * when the baked atlases load — a clone without them keeps the near window and a
   * console warning, not a crash. Required for the same reason as `radiusMetres`.
   */
  farRadiusMetres: number;
  /** Live scene lights, threaded to the far ring's hand-rolled sun term. */
  lights?: FarFoliageLights;
  /** Registered so trunks stop bullets; leaves never do. */
  worldQuery?: CompositeWorldQuery | null;
  waterHeight?: number;
  onStats?: (stats: FoliageStats) => void;
  /**
   * Hands the layer's live debug handles out so the Foliage panel can drive them, the
   * same seam the grass shader uses. Mutated directly by the panel, never read back as
   * React state, so moving a control does not re-render the canvas tree.
   */
  onDebugReady?: (controls: FoliageDebugControls | null) => void;
}

export function FoliageLayer({
  terrain,
  atmosphere,
  density,
  radiusMetres,
  siteSpacing,
  farRadiusMetres,
  lights,
  worldQuery,
  waterHeight,
  onStats,
  onDebugReady,
}: FoliageLayerProps) {
  const gl = useThree((s) => s.gl);
  const variant = parseVariant(BENCH.foliageVariant);
  const alphaMode = parseAlphaMode(BENCH.foliageAlpha);

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
    const uniforms = createFoliageUniforms();
    return { foliage, uniforms, controls: createFoliageDebugControls(uniforms) };
  }, []);

  useEffect(() => () => assets.foliage.texture.dispose(), [assets]);

  useEffect(() => {
    onDebugReady?.(assets.controls);
    return () => onDebugReady?.(null);
  }, [assets, onDebugReady]);

  // The handoff band is a contract between the two tiers, so the layer that owns both
  // sets it — from mount, not as a side effect of whichever tier happens to render first.
  //
  // LAYOUT, not passive. React may flush a passive effect after a frame has already run,
  // and a far-ring fill that ran first would build against the placeholder defaults and
  // produce an EMPTY ring that nothing refills until the next cell crossing. Layout
  // effects complete during commit, before any useFrame callback can fire.
  useLayoutEffect(() => {
    const band = foliageHandoffBand(radiusMetres, field.cellSize);
    assets.uniforms.fadeStart.value = band.fadeStart;
    assets.uniforms.fadeEnd.value = band.fadeEnd;
  }, [assets, radiusMetres, field]);

  // Not in the field's constructor options: rebuilding the field would rebuild every
  // bucket mesh and re-run the pipeline warm-up on every drag.
  useEffect(() => {
    if (density !== undefined) field.setDensity(density);
  }, [field, density]);

  useEffect(() => {
    if (!worldQuery) return;
    return worldQuery.addSource(new VegetationWorldQuery(field));
  }, [worldQuery, field]);

  // Authored tree prototypes. The whole near window WAITS for this fetch to settle
  // (success or failure) rather than mounting twice: a remount is a full bucket
  // rebuild plus a second pipeline warm-up, which costs more than the ~1 MB fetch.
  // "pending" is distinct from null — null means "absent for good, render without".
  const [prototypes, setPrototypes] = useState<TreePrototypes | null | "pending">("pending");
  useEffect(() => {
    let disposed = false;
    let loaded: TreePrototypes | null = null;
    void loadTreePrototypes().then((result) => {
      if (disposed) {
        result?.dispose();
        return;
      }
      loaded = result;
      setPrototypes(result);
    });
    return () => {
      disposed = true;
      loaded?.dispose();
      setPrototypes("pending");
    };
  }, []);

  // Baked far-ring atlases, fetched once. `null` covers both "still loading" and
  // "absent"; either way the near window carries on alone. Keyed on the ENABLED flag,
  // not the radius, so dragging the far dial re-sizes the ring without a refetch.
  const farEnabled = farRadiusMetres > 0;
  const [atlases, setAtlases] = useState<ImpostorAtlases | null>(null);
  useEffect(() => {
    if (!farEnabled) return;
    let disposed = false;
    let loaded: ImpostorAtlases | null = null;
    void loadImpostorAtlases(gl).then((result) => {
      if (disposed) {
        result?.dispose();
        return;
      }
      loaded = result;
      setAtlases(result);
    });
    return () => {
      disposed = true;
      loaded?.dispose();
      setAtlases(null);
    };
  }, [farEnabled, gl]);

  const lastFar = useRef<FarFoliageStats | undefined>(undefined);
  const handleStats = useMemo(
    () => (stats: FoliageStats) => {
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
        farInstances: lastFar.current?.instances,
        farFilling: lastFar.current?.filling,
      });
      onStats?.(stats);
    },
    [variant, alphaMode, field, radiusMetres, assets, onStats]
  );
  const handleFarStats = useMemo(
    () => (stats: FarFoliageStats) => {
      lastFar.current = stats;
    },
    []
  );

  return (
    <>
      <FoliageOverdrawProbe controls={assets.controls} />
      {prototypes !== "pending" && (
        <FoliageCells
          field={field}
          texture={assets.foliage.texture as unknown as THREE.Texture}
          uniforms={assets.uniforms}
          controls={assets.controls}
          atmosphere={atmosphere}
          variant={variant}
          alphaMode={alphaMode}
          prototypes={prototypes}
          radiusMetres={radiusMetres}
          onStats={handleStats}
        />
      )}
      {atlases && farRadiusMetres > 0 && (
        <FarFoliageCells
          field={field}
          atlases={atlases}
          atmosphere={atmosphere}
          foliageUniforms={assets.uniforms}
          controls={assets.controls}
          farRadiusMetres={farRadiusMetres}
          lights={lights}
          onStats={handleFarStats}
        />
      )}
    </>
  );
}
