// WebGPU + React Three Fiber canvas bootstrap (R3F v9).
//
// R3F v9 supports an async `gl` factory: we construct a WebGPURenderer and await
// its init() before the first render, so we never draw before the device is
// ready. Three.js transparently falls back to WebGL2 where WebGPU is
// unavailable (docs/05-engine-architecture-tech-stack.md §3).

import { Canvas, extend } from "@react-three/fiber";
import type { ReactNode } from "react";
import * as THREE from "three/webgpu";
import { CAMERA_NEAR, CAMERA_FAR } from "../df2/config";

// Make the full three (incl. WebGPU node) namespace available as JSX elements.
extend(THREE as never);

interface CameraConfig {
  position: [number, number, number];
  near: number;
  far: number;
  fov: number;
}

const DEFAULT_CAMERA: CameraConfig = {
  position: [0, 210, 380],
  near: CAMERA_NEAR,
  far: CAMERA_FAR,
  fov: 60,
};

export interface GameCanvasProps {
  camera?: CameraConfig;
  dpr?: number | [number, number];
  children?: ReactNode;
}

export function GameCanvas({
  camera = DEFAULT_CAMERA,
  dpr = [1, 1.5],
  children,
}: GameCanvasProps) {
  return (
    <Canvas
      dpr={dpr}
      camera={camera}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer(
          props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]
        );
        await renderer.init();
        return renderer;
      }}
    >
      {children}
    </Canvas>
  );
}
