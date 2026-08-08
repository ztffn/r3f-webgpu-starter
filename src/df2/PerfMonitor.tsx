// Frame-time / draw-call monitor.
//
// Samples inside the render loop but reports on a throttle, so the readout
// itself doesn't perturb what it measures (a setState per frame would).
//
// Frame time is reported alongside FPS because FPS hides the size of a change.
// Going from 120 to 60 fps and from 60 to 40 fps cost the same 8 ms, but read as a
// 60 fps drop and a 20 fps drop. Milliseconds are what you optimise against.
//
// THE DISTRIBUTION LIVES IN frameStats.ts, and that split is the point. A mean plus a
// per-window peak could not answer "did it stutter while I looked around" — the peak was
// erased every reporting interval and frames over 1 s were discarded outright. The
// percentiles, the cumulative histogram and the hitch counters survive reports.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { createFrameStats, type FrameStatsReport } from "./frameStats";

export interface PerfSample {
  fps: number;
  /** Mean frame time over the sampling window, ms. */
  ms: number;
  /** Worst frame in the window, ms — where hitches show up. */
  worstMs: number;
  /**
   * The distribution, and the cumulative counters that outlive a report.
   *
   * `ms` above is a mean, and a mean with hitches in it reads as "no cost" — which it
   * did, on the first GPU measurement of the foliage layer, while the camera visibly
   * snagged. Read `frames.p99Ms`, `frames.worstEverMs` and `frames.hitches` before
   * believing any mean on this panel.
   *
   * OPTIONAL because a hot reload pairs a new reader with the last sample the OLD monitor
   * emitted, which has no distribution on it. Typing it required and guarding it at the
   * use site asserted a guarantee the runtime does not hold.
   */
  frames?: FrameStatsReport;
  /**
   * GPU time for the render pass, ms, or null when unavailable.
   *
   * Requires the renderer to have been constructed with `trackTimestamp` (GameCanvas
   * does so only under `?debug=1`, because the queries are not free). Null is honest:
   * it means "not measured", never "zero".
   */
  gpuMs: number | null;
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
    backend?: { isWebGPUBackend?: boolean; trackTimestamp?: boolean };
    resolveTimestampsAsync?: (type?: string) => Promise<number | undefined>;
  };
  const stats = useRef(createFrameStats());
  const acc = useRef({
    calls: 0,
    tris: 0,
    last: performance.now(),
    since: performance.now(),
    /** Last resolved GPU duration. Null until one resolves; never faked to 0. */
    gpuMs: null as number | null,
    /** One resolve in flight at a time — the promise settles well after the frame. */
    gpuPending: false,
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

    // EVERY frame is recorded. The old sampler dropped anything over 1 s on the
    // reasoning that a tab switch would dominate the worst frame — true, but it also
    // deleted the shader-compile stalls that are the most likely cause of a snag while
    // turning. frameStats counts those separately instead (`pauses`).
    stats.current.record(dt);

    if (now - a.since < interval) return;
    a.since = now;

    const frames = stats.current.report();
    if (frames.windowFrames === 0) return;

    // GPU time is resolved on the report tick, not per frame: the query resolves
    // asynchronously and awaiting it on the frame path would serialise the CPU against
    // the GPU, which is the one thing a profiler must never do to its subject.
    if (gl.backend?.trackTimestamp === true && !a.gpuPending && gl.resolveTimestampsAsync) {
      a.gpuPending = true;
      gl.resolveTimestampsAsync("render")
        .then((duration) => {
          if (typeof duration === "number") a.gpuMs = duration;
        })
        .catch(() => {
          // A backend that cannot resolve should read as "not measured", not as 0.
          a.gpuMs = null;
        })
        .finally(() => {
          a.gpuPending = false;
        });
    }

    onSample({
      fps: 1000 / frames.meanMs,
      ms: frames.meanMs,
      worstMs: frames.worstMs,
      frames,
      gpuMs: a.gpuMs,
      drawCalls: a.calls,
      triangles: a.tris,
      backend: gl.backend?.isWebGPUBackend ? "WebGPU" : "WebGL2",
    });
  });

  return null;
}
