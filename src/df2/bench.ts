// Benchmark overrides, read from the URL query string.
//
// Performance work needs a viewpoint and a configuration that can be reproduced
// exactly, and numbers that can be read without squinting at a screenshot. With
// ?bench=1 the camera is placed at a fixed spot on foot, the knobs below become
// settable per-run, each perf sample is published to window.__perf, and the canopy
// is forced to full height everywhere so the march is measured against a known
// worst case rather than against whatever the map happens to grow underfoot.
//
// Dev affordance only: absent the bench parameter every value falls through to the
// normal config, so nothing here changes how the app behaves for a player.

import type { Stance } from "./FlyControls";

export interface BenchConfig {
  /** True when ?bench=1 — the only switch that changes behaviour. */
  enabled: boolean;
  /** Device pixel ratio override; the ray-count axis. */
  dpr?: number;
  /** Coarse bracket samples per ray; the dominant cost axis. */
  steps?: number;
  /** Bisections inside the bracket. Baked into the graph, so reload to change. */
  refine?: number;
  /** Show the live grass slider panel. Independent of `bench`. */
  debug?: boolean;
  grass?: boolean;
  /**
   * Draw the grass volume's CAP — the screen-covering proxy that gives a ray already
   * inside the canopy somewhere to start. Defaults on; `?grasscap=0` disables it.
   *
   * Exists so the pass can be measured against its own absence at the same pose.
   * Without it the only comparison available was prone-with against standing-without,
   * which differs in the march too and says nothing.
   */
  grassCap?: boolean;
  /** Per-texel share of the baked height field. Baked, so reload to change. */
  strand?: number;
  /** Longest span a ray searches, metres. Sets step size for grazing rays. */
  maxspan?: number;
  /**
   * Grow full-height grass everywhere, ignoring the canopy field. ON by default
   * under `?bench=1`; `?canopyall=0` restores the map's own canopy.
   *
   * Defaulted on because it is the only way to make a bench number MEAN anything on
   * this map. Green Mile's canopy is a colormap-derived stand-in with a median of
   * raw 28 — about 0.13 m — and 11% of the map has none at all. The long-standing
   * bench vantage (5, 375) sits on a texel with raw 0, so it was measuring a march
   * over bare ground. Worse, absent canopy and a broken shader look identical in a
   * normal render, which has already cost sessions.
   *
   * Full canopy is also the WORST CASE for the march, so a frame time measured here
   * is an upper bound rather than a lucky vantage — which is what a benchmark should
   * report. The trade is that it is not what the map says: any claim about grass
   * PLACEMENT or coverage has to be re-checked with `?canopyall=0` (docs/08 §8
   * invariant 5 — results are meaningless without their GrassSource).
   */
  canopyAll?: boolean;
  /**
   * Debug: place human-scale figures as a contrast reference for the grass.
   * Loads third-party models from the untracked testmodels/ directory.
   */
  targets?: boolean;
  stance?: Stance;
  /** Fixed camera position, world metres. */
  x?: number;
  z?: number;
  /** Fixed heading, radians. */
  yaw?: number;
  /** Fixed pitch, radians. */
  pitch?: number;
}

function parse(): BenchConfig {
  if (typeof window === "undefined") return { enabled: false };
  const q = new URLSearchParams(window.location.search);
  const debug = q.get("debug") === "1";
  // The slider panel is useful on its own, without the fixed benchmark vantage.
  if (q.get("bench") !== "1") return { enabled: false, debug };

  const num = (k: string): number | undefined => {
    const v = q.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const stance = q.get("stance");

  return {
    enabled: true,
    debug,
    dpr: num("dpr"),
    steps: num("steps"),
    refine: num("refine"),
    grass: q.get("grass") === null ? undefined : q.get("grass") !== "0",
    grassCap: q.get("grasscap") === null ? undefined : q.get("grasscap") !== "0",
    strand: num("strand"),
    maxspan: num("maxspan"),
    // Default ON under bench — see the field's note. `?canopyall=0` opts out.
    canopyAll: q.get("canopyall") !== "0",
    targets: q.get("targets") === "1",
    stance:
      stance === "stand" || stance === "crouch" || stance === "prone" ? stance : undefined,
    x: num("x"),
    z: num("z"),
    yaw: num("yaw"),
    pitch: num("pitch"),
  };
}

export const BENCH: BenchConfig = parse();

/** Shape published to window.__perf so a driver can read exact numbers. */
export interface BenchSample {
  ms: number;
  fps: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  backend: string;
  dpr: number;
  steps: number;
  grass: boolean;
  stance: string;
  agl: number;
}

declare global {
  interface Window {
    __perf?: BenchSample;
  }
}

export function publish(sample: BenchSample): void {
  if (BENCH.enabled) window.__perf = sample;
}
