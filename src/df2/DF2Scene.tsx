// Scene composition: atmosphere, lights, water, terrain, camera.
//
// Loads a real extracted DF terrain if its prepared assets are present
// (see tools/df2-extract), otherwise falls back to synthetic fBm terrain.

import { useEffect, useMemo, useState } from "react";
import { MapControls } from "@react-three/drei";
import * as THREE from "three/webgpu";
import { Terrain } from "./Terrain";
import { Heightfield } from "./Heightfield";
import { createTerrainMaterial } from "./TerrainMaterial";
import { loadTerrain, type LoadedTerrain } from "./loadTerrain";
import {
  TERRAIN_SLUG,
  HEIGHT_SCALE,
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
  onStatus?: (status: { loading: boolean; terrain: LoadedTerrain | null }) => void;
}

export function DF2Scene({ wireframe = false, onStatus }: DF2SceneProps) {
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

  // Frame the camera to the map: high enough to see the whole terrain.
  const camTarget = heightfield ? (heightfield.minHeight + heightfield.maxHeight) / 2 : 30;

  return (
    <>
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
        <Terrain heightfield={heightfield} material={material} wireframe={wireframe} />
      )}

      {showWater && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, waterLevel, 0]}>
          <planeGeometry args={[worldSize, worldSize]} />
          <primitive object={waterMaterial} attach="material" />
        </mesh>
      )}

      <MapControls
        makeDefault
        target={[0, camTarget, 0]}
        enableDamping
        dampingFactor={0.08}
        minDistance={40}
        maxDistance={worldSize * 1.6}
        maxPolarAngle={1.45}
      />
    </>
  );
}
