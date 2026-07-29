// Scene composition: atmosphere, lights, water, terrain, camera.
//
// Loads a real extracted DF terrain if its prepared assets are present
// (see tools/df2-extract), otherwise falls back to synthetic fBm terrain.

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import { Terrain } from "./Terrain";
import { PerfMonitor, type PerfSample } from "./PerfMonitor";
import { FlyControls, type FlyState, type Stance } from "./FlyControls";
import { Heightfield } from "./Heightfield";
import { createTerrainMaterial } from "./TerrainMaterial";
import { createGrassMaterial } from "./GrassMaterial";
import { loadTerrain, type LoadedTerrain } from "./loadTerrain";
import {
  TERRAIN_SLUG,
  HEIGHT_SCALE,
  METERS_PER_TEXEL,
  GRASS_SCALE,
  GRASS_STEPS,
  GRASS_CELL,
  GRASS_TONE_VARIATION,
  GRASS_FADE_START,
  GRASS_FADE_END,
  WATER_COLOR,
  SUN_DIRECTION,
  SKY_COLOR,
  FOG_COLOR,
  FOG_NEAR,
  FOG_FAR,
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

  const heightfield = useMemo(() => {
    if (loaded === undefined) return null; // don't build anything while loading
    return loaded
      ? Heightfield.fromHeightmap({ data: loaded.heights, size: loaded.size })
      : Heightfield.synthetic();
  }, [loaded]);

  const material = useMemo(() => {
    if (loaded === undefined) return null;
    return createTerrainMaterial({
      colorMap: loaded?.colorMap ?? null,
      filter: loaded?.filter,
    });
  }, [loaded]);

  useEffect(() => () => material?.dispose(), [material]);

  // --- columnar grass (docs/07) ---------------------------------------------
  const grassKit = useMemo(() => {
    if (!loaded || !loaded.grassMap || !loaded.colorMap) return null;
    // Elevation as a texture for the fragment march. Built from the same raw
    // samples as the CPU heightfield, so shader and gameplay agree exactly.
    const heightTex = new THREE.DataTexture(
      loaded.heights,
      loaded.size,
      loaded.size,
      THREE.RedFormat,
      THREE.UnsignedByteType
    );
    heightTex.magFilter = THREE.LinearFilter;
    heightTex.minFilter = THREE.LinearFilter;
    heightTex.wrapS = THREE.RepeatWrapping;
    heightTex.wrapT = THREE.RepeatWrapping;
    heightTex.needsUpdate = true;

    const kit = createGrassMaterial({
      grassMap: loaded.grassMap,
      heightMap: heightTex,
      colorMap: loaded.colorMap,
      worldSize: loaded.size * METERS_PER_TEXEL,
      mapSize: loaded.size,
      heightScale: HEIGHT_SCALE,
      grassScale: GRASS_SCALE,
      steps: GRASS_STEPS,
      cellSize: GRASS_CELL,
      toneVariation: GRASS_TONE_VARIATION,
      fadeStart: GRASS_FADE_START,
      fadeEnd: GRASS_FADE_END,
    });
    return { ...kit, heightTex };
  }, [loaded]);

  useEffect(
    () => () => {
      grassKit?.material.dispose();
      grassKit?.heightTex.dispose();
    },
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

  const worldSize = heightfield?.worldSize ?? 1024;
  // .trn water_height is in raw elevation units, same scale as the heightmap.
  const waterLevel = (loaded?.waterHeight ?? 0) * HEIGHT_SCALE;
  const showWater = !!heightfield && waterLevel > heightfield.minHeight;
  // The terrain tiles forever, so water must too — make the plane large enough
  // to exceed the fog distance from anywhere the camera can be.
  const waterSpan = Math.max(worldSize * 4, FOG_FAR * 4);

  return (
    <>
      {onPerf && <PerfMonitor onSample={onPerf} />}

      <color attach="background" args={[SKY_COLOR]} />
      <fog attach="fog" args={[FOG_COLOR, FOG_NEAR, FOG_FAR]} />

      {/* Sun */}
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
          grassMaterial={grass ? (grassKit?.material ?? null) : null}
          grassDistance={GRASS_FADE_END}
          wireframe={wireframe}
        />
      )}

      {showWater && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, waterLevel, 0]}>
          <planeGeometry args={[waterSpan, waterSpan]} />
          <primitive object={waterMaterial} attach="material" />
        </mesh>
      )}

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
