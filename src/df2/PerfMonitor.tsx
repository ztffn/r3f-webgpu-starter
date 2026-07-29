// Frame-time / draw-call monitor.
//
// Samples inside the render loop but reports on a throttle, so the readout
// itself doesn't perturb what it measures (a setState per frame would).
//
// Frame time is reported alongside FPS because FPS hides the size of a change.
// Going from 120 to 60 fps and from 60 to 40 fps cost the same 8 ms, but read as a
// 60 fps drop and a 20 fps drop. Milliseconds are what you optimise against.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";

export interface PerfSample {
  fps: number;
  /** Mean frame time over the sampling window, ms. */
  ms: number;
  /** Worst frame in the window, ms — where hitches show up. */
  worstMs: number;
  drawCalls: number;
  triangles: number;
  /**
   * Which backend actually initialised. Worth surfacing on a test build: a
   * tester reporting "it's slow" means something very different on the WebGL2
   * fallback than on WebGPU, and there's no way to tell from a screenshot.
   */
  backend: "WebGPU" | "WebGL2";
}

export interface PerfMonitorProps {
  onSample: (s: PerfSample) => void;
  /** Reporting interval, ms. */
  interval?: number;
}

export function PerfMonitor({ onSample, interval = 500 }: PerfMonitorProps) {
  const gl = useThree((s) => s.gl) as unknown as {
    info?: {
      autoReset?: boolean;
      reset?: () => void;
      render?: { drawCalls?: number; triangles?: number };
    };
    backend?: { isWebGPUBackend?: boolean };
  };
  const acc = useRef({
    frames: 0,
    total: 0,
    worst: 0,
    calls: 0,
    tris: 0,
    last: performance.now(),
    since: performance.now(),
  });

  // three's WebGPU path zeroes info at the TOP of its rAF callback, before R3F
  // runs frame subscribers — so reading it from useFrame always yields 0. Take
  // ownership of the reset instead: read last frame's totals here, then clear
  // them so this frame's render accumulates cleanly.
  useEffect(() => {
    const info = gl.info;
    if (!info) return;
    const prev = info.autoReset;
    info.autoReset = false;
    return () => {
      info.autoReset = prev;
    };
  }, [gl]);

  useFrame(() => {
    const a = acc.current;
    const now = performance.now();
    const dt = now - a.last;
    a.last = now;

    a.calls = gl.info?.render?.drawCalls ?? 0;
    a.tris = gl.info?.render?.triangles ?? 0;
    gl.info?.reset?.();

    // Ignore the first frame after a stall (tab switch, shader compile), which
    // would otherwise dominate the worst-frame figure.
    if (dt < 1000) {
      a.frames++;
      a.total += dt;
      if (dt > a.worst) a.worst = dt;
    }

    if (now - a.since >= interval && a.frames > 0) {
      const mean = a.total / a.frames;
      onSample({
        fps: 1000 / mean,
        ms: mean,
        worstMs: a.worst,
        drawCalls: a.calls,
        triangles: a.tris,
        backend: gl.backend?.isWebGPUBackend ? "WebGPU" : "WebGL2",
      });
      a.frames = 0;
      a.total = 0;
      a.worst = 0;
      a.since = now;
    }
  });

  return null;
}
