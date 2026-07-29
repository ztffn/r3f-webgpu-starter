// Benchmark overrides, read from the URL query string.
//
// Performance work needs a viewpoint and a configuration that can be reproduced
// exactly, and numbers that can be read without squinting at a screenshot. With
// ?bench=1 the camera is placed at a fixed spot on foot, the knobs below become
// settable per-run, and each perf sample is published to window.__perf.
//
// Dev affordance only: absent the bench parameter every value falls through to the
// normal config, so nothing here changes how the app behaves for a player.

import type { Stance } from "./FlyControls";

export interface BenchConfig {
  /** True when ?bench=1 — the only switch that changes behaviour. */
  enabled: boolean;
  /** Device pixel ratio override; the ray-count axis. */
  dpr?: number;
  /** Grass march iteration cap; the steps-per-ray axis. */
  steps?: number;
  grass?: boolean;
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
  if (q.get("bench") !== "1") return { enabled: false };

  const num = (k: string): number | undefined => {
    const v = q.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const stance = q.get("stance");

  return {
    enabled: true,
    dpr: num("dpr"),
    steps: num("steps"),
    grass: q.get("grass") === null ? undefined : q.get("grass") !== "0",
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
