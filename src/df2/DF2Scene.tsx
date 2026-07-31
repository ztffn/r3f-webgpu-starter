// Scene composition: atmosphere, lights, water, terrain, camera.
//
// Loads a real extracted DF terrain if its prepared assets are present
// (see tools/df2-extract), otherwise falls back to synthetic fBm terrain.
//
// Both paths produce the SAME set of inputs — a pre-shaded colormap, an 8-bit
// elevation grid and a canopy field — so terrain and grass need no mode switch and
// the grass system is visible with no game data present.

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { Terrain } from "./Terrain";
import { PerfMonitor, type PerfSample } from "./PerfMonitor";
import { FlyControls, type FlyState, type Stance } from "./FlyControls";
import { Heightfield } from "./Heightfield";
import { createTerrainMaterial } from "./TerrainMaterial";
import { createGrassMaterial, type GrassUniforms } from "./GrassMaterial";
import { bakeSyntheticMaps } from "./syntheticMaps";
import { bakeGrassJitter } from "./grassJitter";
import { loadTerrain, type LoadedTerrain } from "./loadTerrain";
import { WeaponPrototype } from "../fps/WeaponPrototype";
import { ThreeWorldQuery } from "../fps/core/WorldQuery";
// Lazily imported so the three multi-megabyte debug models are code-split out of the
// main bundle and only fetched when ?targets=1 actually asks for them.
const TestTargets = lazy(() =>
  import("../fps/TestTargets").then((m) => ({ default: m.TestTargets }))
);
import { BENCH } from "./bench";
import {
  TERRAIN_SLUG,
  HEIGHT_SCALE,
  METERS_PER_TEXEL,
  GRASS_SCALE,
  GRASS_STEPS,
  GRASS_STEPS_RUN,
  GRASS_CELL,
  GRASS_NEAR_CLIP,
  GRASS_REFINE_STEPS,
  GRASS_MAX_SPAN,
  GRASS_STRIPE_PIXELS,
  GRASS_HASH_PERIOD,
  GRASS_TONE_VARIATION,
  GRASS_SHADE_BASE,
  GRASS_STRAND_JITTER,
  GRASS_STRAND_MIX,
  GRASS_FADE_START,
  GRASS_FADE_END,
  WATER_COLOR,
  SUN_DIRECTION,
  SKY_COLOR,
  FOG_COLOR,
  FOG_NEAR,
  FOG_FAR,
  REFERENCE_P11,
} from "./config";

const SUN_DISTANCE = 2000;

export interface DF2SceneProps {
  wireframe?: boolean;
  grass?: boolean;
  grounded?: boolean;
  stance?: Stance;
  onPerf?: (s: PerfSample) => void;
  onFly?: (s: FlyState) => void;
  onToggleGround?: () => void;
  onStance?: (s: Stance) => void;
  onStatus?: (status: { loading: boolean; terrain: LoadedTerrain | null }) => void;
  /** Hands the grass shader's live uniforms out so a debug panel can drive them. */
  onGrassReady?: (u: GrassUniforms | null) => void;
  /** Renders the integrated first-person optic prototype on top of this world. */
  scopeDemo?: boolean;
  /** Isolated animated rifle-and-hands test scene. */
  weaponDemo?: boolean;
}

/**
 * Water plane that follows the camera.
 *
 * The terrain tiles forever and its chunk window recentres every frame, so a plane
 * pinned to the world origin ran out: past its half-extent the camera flew over
 * terrain with no water and any basin below water level rendered dry. Snapped to a
 * coarse grid so it does not shimmer as it moves.
 */
function Water({ level, span, material }: { level: number; span: number; material: THREE.Material }) {
  const { camera } = useThree();
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(span, span), material);
    m.rotation.x = -Math.PI / 2;
    m.frustumCulled = false;
    return m;
  }, [span, material]);

  useEffect(() => () => mesh.geometry.dispose(), [mesh]);

  useFrame(() => {
    const step = span / 8;
    mesh.position.set(
      Math.round(camera.position.x / step) * step,
      level,
      Math.round(camera.position.z / step) * step
    );
  });

  return <primitive object={mesh} />;
}

export function DF2Scene({
  wireframe = false,
  grass = true,
  grounded = false,
  stance = "stand",
  onStatus,
  onPerf,
  onFly,
  onToggleGround,
  onStance,
  onGrassReady,
  scopeDemo = false,
  weaponDemo = false,
}: DF2SceneProps) {
  const worldQuery = useMemo(() => new ThreeWorldQuery(0), []);
  // undefined = still loading, null = no assets (synthetic), object = real map
  const [loaded, setLoaded] = useState<LoadedTerrain | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    loadTerrain(TERRAIN_SLUG).then((t) => {
      if (alive) setLoaded(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    onStatus?.({ loading: loaded === undefined, terrain: loaded ?? null });
  }, [loaded, onStatus]);

  // One bundle for both modes: elevation bytes, colormap, canopy.
  const world = useMemo(() => {
    if (loaded === undefined) return null; // don't build anything while loading

    if (loaded) {
      const heightfield = Heightfield.fromHeightmap({
        data: loaded.heights,
        size: loaded.size,
        metersPerTexel: METERS_PER_TEXEL,
        heightScale: HEIGHT_SCALE,
      });
      return {
        heightfield,
        heights: loaded.heights,
        heightSize: loaded.size,
        size: loaded.size,
        colorMap: loaded.colorMap,
        grassMap: loaded.grassMap,
        filter: loaded.filter,
        waterHeight: loaded.waterHeight,
      };
    }

    const bytes = Heightfield.syntheticBytes();
    const heightfield = Heightfield.fromHeightmap(bytes);
    const { colorMap, grassMap, size } = bakeSyntheticMaps(heightfield);
    return {
      heightfield,
      heights: bytes.data,
      // Elevation grid and colour grid differ here (see syntheticMaps). Both are
      // sampled by normalised uv, so only the COLOUR texel size matters downstream.
      heightSize: bytes.size,
      size,
      colorMap,
      grassMap,
      filter: undefined,
      waterHeight: 0,
    };
  }, [loaded]);

  const material = useMemo(
    () => (world?.colorMap ? createTerrainMaterial({ colorMap: world.colorMap, filter: world.filter }) : null),
    [world]
  );
  useEffect(() => () => material?.dispose(), [material]);

  // --- columnar grass (docs/07) ---------------------------------------------
  const grassKit = useMemo(() => {
    if (!world?.grassMap || !world.colorMap) return null;
    // Elevation as a texture for the fragment march. Built from the same raw
    // samples as the CPU heightfield, so shader and gameplay agree exactly.
    // HALF-FLOAT, carrying METRES, and built from the heightfield's own grid — not from
    // the raw bytes.
    //
    // The grid has been reconstructed to remove 8-bit terracing (Heightfield.
    // smoothTerracing), so uploading the raw bytes here would leave the grass marching a
    // quantised surface while the terrain mesh drew a smoothed one. They would disagree
    // by up to half a metre and grass would float or sink — docs/08 §8 invariant 3.
    //
    // Half rather than float32: WebGPU does not guarantee float32 textures are
    // filterable, and this needs LINEAR. Half gives ~0.1 m precision over this map's
    // 169 m of relief, which is well under the 1 m step being removed.
    const heightData = new Uint16Array(world.heightfield.grid.length);
    for (let i = 0; i < heightData.length; i++) {
      heightData[i] = THREE.DataUtils.toHalfFloat(world.heightfield.grid[i]);
    }
    const heightTex = new THREE.DataTexture(
      heightData,
      world.heightfield.period,
      world.heightfield.period,
      THREE.RedFormat,
      THREE.HalfFloatType
    );
    heightTex.magFilter = THREE.LinearFilter;
    heightTex.minFilter = THREE.LinearFilter;
    heightTex.wrapS = THREE.RepeatWrapping;
    heightTex.wrapT = THREE.RepeatWrapping;
    heightTex.needsUpdate = true;

    // Baked once per terrain and shared by every chunk. See grassJitter.ts for why
    // this is a texture rather than a hash evaluated in the march.
    const jitter = bakeGrassJitter(
      GRASS_HASH_PERIOD,
      BENCH.strand ?? GRASS_STRAND_JITTER
    );

    const kit = createGrassMaterial({
      grassMap: world.grassMap,
      jitterMap: jitter,
      heightMap: heightTex,
      colorMap: world.colorMap,
      worldSize: world.heightfield.worldSize,
      grassScale: GRASS_SCALE,
      // ?steps= raises the compiled CEILING as well as the running value, so asking for
      // more samples than the shipped ceiling just works instead of being silently
      // clamped to it.
      steps: Math.max(GRASS_STEPS, BENCH.steps ?? 0),
      stepsRun: BENCH.steps ?? GRASS_STEPS_RUN,
      cellSize: GRASS_CELL,
      nearClip: GRASS_NEAR_CLIP,
      refineSteps: BENCH.refine ?? GRASS_REFINE_STEPS,
      maxSpan: BENCH.maxspan ?? GRASS_MAX_SPAN,
      stripePixels: GRASS_STRIPE_PIXELS,
      hashPeriod: GRASS_HASH_PERIOD,
      toneVariation: GRASS_TONE_VARIATION,
      shadeBase: GRASS_SHADE_BASE,
      strandMix: GRASS_STRAND_MIX,
      canopyForce: BENCH.canopyAll ?? false,
      fadeStart: GRASS_FADE_START,
      fadeEnd: GRASS_FADE_END,
      referenceP11: REFERENCE_P11,
      // Fog is applied by the material from the hit distance, not by three from the
      // shell depth, so it needs the scene's fog values.
      fogColor: FOG_COLOR,
      fogNear: FOG_NEAR,
      fogFar: FOG_FAR,
    });
    return { ...kit, heightTex, jitterTex: jitter };
  }, [world]);

  useEffect(
    () => () => {
      grassKit?.material.dispose();
      grassKit?.floorMaterial.dispose();
      grassKit?.heightTex.dispose();
      grassKit?.jitterTex.dispose();
    },
    [grassKit]
  );

  useEffect(() => {
    onGrassReady?.(grassKit?.uniforms ?? null);
  }, [grassKit, onGrassReady]);

  // Stable identity so Terrain's slot memo does not rebuild; reads the uniform at
  // call time so the canopy slider takes effect without a React render.
  const grassCanopyMax = useCallback(
    () => Number(grassKit?.uniforms.canopyMax.value ?? 0),
    [grassKit]
  );

  const waterMaterial = useMemo(() => {
    const m = new THREE.MeshStandardNodeMaterial();
    m.color = new THREE.Color(WATER_COLOR);
    m.roughness = 0.15;
    m.transparent = true;
    m.opacity = 0.82;
    return m;
  }, []);
  useEffect(() => () => waterMaterial.dispose(), [waterMaterial]);

  const heightfield = world?.heightfield ?? null;
  // .trn water_height is in raw elevation units, same scale as the heightmap.
  const waterLevel = (world?.waterHeight ?? 0) * HEIGHT_SCALE;
  const showWater = !!heightfield && waterLevel > heightfield.minHeight;
  // Follows the camera, so it only has to out-reach the fog, not the world.
  const waterSpan = FOG_FAR * 3;

  return (
    <>
      {onPerf && <PerfMonitor onSample={onPerf} />}

      <color attach="background" args={[SKY_COLOR]} />
      <fog attach="fog" args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />

      {/* Sun. The terrain is unlit (its colormap is pre-shaded); this lights the
          water and anything else added to the scene later. */}
      <directionalLight
        position={[
          SUN_DIRECTION[0] * SUN_DISTANCE,
          SUN_DIRECTION[1] * SUN_DISTANCE,
          SUN_DIRECTION[2] * SUN_DISTANCE,
        ]}
        intensity={2.4}
        color={"#fff4e0"}
      />
      {/* Sky/ground fill */}
      <hemisphereLight args={[SKY_COLOR, "#5a5340", 0.75]} position={[0, 400, 0]} />

      {heightfield && material && (
        <Terrain
          heightfield={heightfield}
          material={material}
          grassMaterial={grassKit?.material ?? null}
          grassFloorMaterial={
            BENCH.grassFloor === false ? null : grassKit?.floorMaterial ?? null
          }
          grassEnabled={grass}
          grassDistance={GRASS_FADE_END}
          // Read live: the debug panel writes this uniform without a React render.
          grassCanopyMax={grassCanopyMax}
          wireframe={wireframe}
        />
      )}

      {/* Scope mode promotes the contrast ladder into resettable shootable targets. */}
      {(BENCH.targets || scopeDemo) && heightfield && (
        <Suspense fallback={null}>
          <TestTargets
            heightfield={heightfield}
            originX={BENCH.targets ? (BENCH.x ?? 5) : 0}
            originZ={BENCH.targets ? (BENCH.z ?? 375) : 320}
            worldQuery={worldQuery}
          />
        </Suspense>
      )}

      {showWater && <Water level={waterLevel} span={waterSpan} material={waterMaterial} />}

      {heightfield && (
        <FlyControls
          heightfield={heightfield}
          grounded={grounded}
          stance={stance}
          onState={onFly}
          onToggleGround={onToggleGround}
          onStance={onStance}
        />
      )}

      {/* Kept opt-in while the existing terrain visual work remains the default. */}
      {(scopeDemo || weaponDemo) && (
        <WeaponPrototype
          scopeDemo={scopeDemo}
          worldQuery={worldQuery}
          stance={stance}
          grounded={grounded}
        />
      )}
    </>
  );
}
