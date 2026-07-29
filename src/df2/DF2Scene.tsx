// Scene composition: atmosphere, lights, water, terrain, camera.
//
// Loads a real extracted DF terrain if its prepared assets are present
// (see tools/df2-extract), otherwise falls back to synthetic fBm terrain.
//
// Both paths produce the SAME set of inputs — a pre-shaded colormap, an 8-bit
// elevation grid and a canopy field — so terrain and grass need no mode switch and
// the grass system is visible with no game data present.

import { useEffect, useMemo, useState } from "react";
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
import { BENCH } from "./bench";
import {
  TERRAIN_SLUG,
  HEIGHT_SCALE,
  METERS_PER_TEXEL,
  GRASS_SCALE,
  GRASS_STEPS,
  GRASS_CELL,
  GRASS_NEAR_CLIP,
  GRASS_REFINE_STEPS,
  GRASS_MAX_SPAN,
  GRASS_STRIPE_PIXELS,
  GRASS_HASH_PERIOD,
  GRASS_TONE_VARIATION,
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
}: DF2SceneProps) {
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
    const heightTex = new THREE.DataTexture(
      world.heights,
      world.heightSize,
      world.heightSize,
      THREE.RedFormat,
      THREE.UnsignedByteType
    );
    heightTex.magFilter = THREE.LinearFilter;
    heightTex.minFilter = THREE.LinearFilter;
    heightTex.wrapS = THREE.RepeatWrapping;
    heightTex.wrapT = THREE.RepeatWrapping;
    heightTex.needsUpdate = true;

    // Baked once per terrain and shared by every chunk. See grassJitter.ts for why
    // this is a texture rather than a hash evaluated in the march.
    const jitter = bakeGrassJitter(GRASS_HASH_PERIOD);

    const kit = createGrassMaterial({
      grassMap: world.grassMap,
      jitterMap: jitter.texture,
      heightMap: heightTex,
      colorMap: world.colorMap,
      worldSize: world.heightfield.worldSize,
      mapSize: world.size,
      heightScale: world.heightfield.heightScale,
      grassScale: GRASS_SCALE,
      steps: BENCH.steps ?? GRASS_STEPS,
      cellSize: GRASS_CELL,
      nearClip: GRASS_NEAR_CLIP,
      refineSteps: BENCH.refine ?? GRASS_REFINE_STEPS,
      maxSpan: GRASS_MAX_SPAN,
      stripePixels: GRASS_STRIPE_PIXELS,
      hashPeriod: GRASS_HASH_PERIOD,
      toneVariation: GRASS_TONE_VARIATION,
      fadeStart: GRASS_FADE_START,
      fadeEnd: GRASS_FADE_END,
      referenceP11: REFERENCE_P11,
      // Fog is applied by the material from the hit distance, not by three from the
      // shell depth, so it needs the scene's fog values.
      fogColor: FOG_COLOR,
      fogNear: FOG_NEAR,
      fogFar: FOG_FAR,
    });
    return { ...kit, heightTex, jitterTex: jitter.texture };
  }, [world]);

  useEffect(
    () => () => {
      grassKit?.material.dispose();
      grassKit?.heightTex.dispose();
      grassKit?.jitterTex.dispose();
    },
    [grassKit]
  );

  useEffect(() => {
    onGrassReady?.(grassKit?.uniforms ?? null);
  }, [grassKit, onGrassReady]);

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
          grassEnabled={grass}
          grassDistance={GRASS_FADE_END}
          wireframe={wireframe}
        />
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
    </>
  );
}
