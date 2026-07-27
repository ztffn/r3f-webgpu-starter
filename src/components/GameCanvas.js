// WebGPU + React Three Fiber canvas bootstrap.
//
// Generalized from the starter's canvas: owns WebGPURenderer setup and only
// starts the frameloop once the device has initialized. Accepts a `camera` prop
// so scenes can set world-appropriate near/far/position — terrain needs a far
// plane in the thousands of meters (05-engine-architecture-tech-stack.md §3).
// Three.js transparently falls back to WebGL2 where WebGPU is unavailable.

import { Canvas, extend } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { ResizeHandler } from "./ResizeHandler";
import { CAMERA_NEAR, CAMERA_FAR } from "../df2/config.js";

extend(THREE);

const DEFAULT_CAMERA = {
  position: [0, 210, 380],
  near: CAMERA_NEAR,
  far: CAMERA_FAR,
  fov: 60,
};

export function GameCanvas({ camera = DEFAULT_CAMERA, dpr = [1, 1.5], children }) {
  const rendererRef = useRef();
  const [frameloop, setFrameloop] = useState("never");

  return (
    <Canvas
      onCreated={(state) => {
        state.setSize(window.innerWidth, window.innerHeight);
      }}
      frameloop={frameloop}
      dpr={dpr}
      camera={camera}
      gl={(canvas) => {
        const renderer = new THREE.WebGPURenderer({
          canvas,
          powerPreference: "high-performance",
          antialias: true,
          alpha: false,
          stencil: false,
        });

        // Flip the frameloop on only once WebGPU is ready.
        renderer.init().then(() => setFrameloop("always"));
        rendererRef.current = renderer;
        return renderer;
      }}
    >
      {children}
      <ResizeHandler rendererRef={rendererRef} />
    </Canvas>
  );
}
