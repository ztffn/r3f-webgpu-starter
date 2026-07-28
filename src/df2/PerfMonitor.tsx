// Frame-time / draw-call monitor.
//
// Samples inside the render loop but reports on a throttle, so the readout
// itself doesn't perturb what it measures (a setState per frame would).
//
// Frame time is reported alongside FPS because FPS compresses exactly where it
// matters: 120->60fps and 60->40fps are both "‑60", but the first costs 8 ms and
// the second 8 ms too — ms is the number to optimise against.

import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";

export interface PerfSample {
  fps: number;
  /** Mean frame time over the sampling window, ms. */
  ms: number;
  /** Worst frame in the window, ms — where hitches show up. */
  worstMs: number;
  drawCalls: number;
  triangles: number;
}

export interface PerfMonitorProps {
  onSample: (s: PerfSample) => void;
  /** Reporting interval, ms. */
  interval?: number;
}

export function PerfMonitor({ onSample, interval = 500 }: PerfMonitorProps) {
  const gl = useThree((s) => s.gl) as unknown as {
    info?: { render?: { drawCalls?: number; triangles?: number } };
  };
  const acc = useRef({ frames: 0, total: 0, worst: 0, last: performance.now(), since: performance.now() });

  useFrame(() => {
    const a = acc.current;
    const now = performance.now();
    const dt = now - a.last;
    a.last = now;

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
        drawCalls: gl.info?.render?.drawCalls ?? 0,
        triangles: gl.info?.render?.triangles ?? 0,
      });
      a.frames = 0;
      a.total = 0;
      a.worst = 0;
      a.since = now;
    }
  });

  return null;
}
