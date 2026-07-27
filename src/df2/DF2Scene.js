// Scene composition for the DF2 terrain scaffold: atmosphere, lights, water,
// the terrain itself, and a map-style camera.

import { MapControls } from "@react-three/drei";
import { Terrain } from "./Terrain.js";
import {
  WORLD_SIZE,
  WATER_LEVEL,
  SUN_DIRECTION,
  SKY_COLOR,
  FOG_COLOR,
  FOG_NEAR,
  FOG_FAR,
} from "./config.js";

const SUN_DISTANCE = 800;

export function DF2Scene({ wireframe = false }) {
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
      <hemisphereLight
        args={[SKY_COLOR, "#5a5340", 0.7]}
        position={[0, 200, 0]}
      />

      <Terrain wireframe={wireframe} />

      {/* Simple water plane at the map's water level */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, WATER_LEVEL, 0]}>
        <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
        <meshStandardNodeMaterial
          color={"#2a4a63"}
          roughness={0.15}
          metalness={0.0}
          transparent
          opacity={0.82}
        />
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
