// Scene composition for the DF2 terrain scaffold: atmosphere, lights, water,
// the terrain itself, and a map-style camera.

import { useEffect, useMemo } from "react";
import { MapControls } from "@react-three/drei";
import * as THREE from "three/webgpu";
import { Terrain } from "./Terrain";
import {
  WORLD_SIZE,
  WATER_LEVEL,
  SUN_DIRECTION,
  SKY_COLOR,
  FOG_COLOR,
  FOG_NEAR,
  FOG_FAR,
} from "./config";

const SUN_DISTANCE = 800;

export interface DF2SceneProps {
  wireframe?: boolean;
}

export function DF2Scene({ wireframe = false }: DF2SceneProps) {
  // Built imperatively (a node material) so we don't need JSX typings for the
  // WebGPU node-material elements.
  const waterMaterial = useMemo(() => {
    const m = new THREE.MeshStandardNodeMaterial();
    m.color = new THREE.Color("#2a4a63");
    m.roughness = 0.15;
    m.metalness = 0.0;
    m.transparent = true;
    m.opacity = 0.82;
    return m;
  }, []);

  useEffect(() => () => waterMaterial.dispose(), [waterMaterial]);

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
        intensity={2.6}
        color={"#fff4e0"}
      />
      {/* Sky/ground fill */}
      <hemisphereLight args={[SKY_COLOR, "#5a5340", 0.7]} position={[0, 200, 0]} />

      <Terrain wireframe={wireframe} />

      {/* Simple water plane at the map's water level */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, WATER_LEVEL, 0]}>
        <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
        <primitive object={waterMaterial} attach="material" />
      </mesh>

      <MapControls
        makeDefault
        target={[0, 30, 0]}
        enableDamping
        dampingFactor={0.08}
        minDistance={30}
        maxDistance={1600}
        maxPolarAngle={1.45}
      />
    </>
  );
}
