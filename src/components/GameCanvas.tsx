// WebGPU + React Three Fiber canvas bootstrap (R3F v9).
//
// R3F v9 supports an async `gl` factory: we construct a WebGPURenderer and await
// its init() before the first render, so we never draw before the device is
// ready. Three.js transparently falls back to WebGL2 where WebGPU is
// unavailable (docs/05-engine-architecture-tech-stack.md §3).

import { Canvas, extend } from "@react-three/fiber";
import type { ReactNode } from "react";
import * as THREE from "three/webgpu";
import { CAMERA_NEAR, CAMERA_FAR, CAMERA_FOV } from "../df2/config";
import { BENCH } from "../df2/bench";

// Make the full three (incl. WebGPU node) namespace available as JSX elements.
extend(THREE as never);

interface CameraConfig {
  position: [number, number, number];
  near: number;
  far: number;
  fov: number;
}

const DEFAULT_CAMERA: CameraConfig = {
  // Only the first frame: FlyControls takes the position over immediately and
  // places the rig above the terrain (see FlyControls, `rig.initialised`).
  position: [0, 520, 900],
  near: CAMERA_NEAR,
  far: CAMERA_FAR,
  // From config, not a literal: the grass shader measures its zoom factor against
  // this FOV, so a mismatch made every unaided frame read as partly scoped.
  fov: CAMERA_FOV,
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
  // A fixed dpr under ?bench=1: the ray-count axis has to be settable, and an
  // adaptive range would make two runs incomparable.
  const effectiveDpr = BENCH.dpr ?? dpr;
  return (
    <Canvas
      dpr={effectiveDpr}
      camera={camera}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer({
          ...(props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]),
          // GPU TIMING, and only under ?debug=1 because the queries are not free.
          // A CONSTRUCTOR parameter, not a settable property: the backend reads
          // `parameters.trackTimestamp` once (three's Backend.js), so it cannot be
          // switched on later from a panel. Without it `resolveTimestampsAsync`
          // warns and returns undefined, which PerfMonitor reports as "not
          // measured" rather than as zero.
          trackTimestamp: BENCH.debug === true,
        });
        await renderer.init();
        return renderer;
      }}
    >
      {children}
    </Canvas>
  );
}
