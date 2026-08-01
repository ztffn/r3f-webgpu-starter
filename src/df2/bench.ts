// Benchmark overrides, read from the URL query string.
//
// Performance work needs a viewpoint and a configuration that can be reproduced
// exactly, and numbers that can be read without squinting at a screenshot. With
// ?bench=1 the camera is placed at a fixed spot on foot, the knobs below become
// settable per-run, each perf sample is published to window.__perf, and the canopy
// is forced to full height everywhere so the march is measured against a known
// worst case rather than against whatever the map happens to grow underfoot.
//
// Dev affordance only. Absent the bench parameter every value falls through to the
// normal config, with three deliberate exceptions that are useful without a fixed
// vantage and are opt-in by an explicit URL parameter a player never types:
// `?debug=1` (slider panel), `?canopyall=1` (force full canopy) and `?blades=`
// (the near-field blade layer, which docs/03 §4.2 wants A/B-able against the
// authentic bladeless look from a camera you can steer).

import type { Stance } from "./FlyControls";

export interface BenchConfig {
  /** True when ?bench=1 — the fixed vantage and the published sample. */
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
  /**
   * Draw the near-field instanced BLADE layer (docs/03 §4.4). Defaults on;
   * `?blades=0` disables it.
   *
   * Written before the layer existed, deliberately. The cap's own cost — 9.7 ms —
   * stayed invisible for a whole session because there was no way to render the same
   * pose without it, and the blade layer is the same shape of risk: an overlay whose
   * cost lands in overdraw, prone, where nothing else changes on screen.
   *
   * Parsed WITHOUT `?bench=1` as well, unlike `grassCap`. Two different jobs: the bench
   * one is measurement, but docs/03 §4.2 also asks for blades to be A/B'd against the
   * authentic bladeless look, and that comparison needs a free camera rather than the
   * fixed bench vantage — the same reasoning that split `?canopyall=` out.
   */
  blades?: boolean;
  /** Blade instance count; the pool size, and the first dial to turn on cost. */
  bladeCount?: number;
  /** Blade field radius in metres; the second dial, and it moves density with it. */
  bladeRadius?: number;
  /**
   * Blade debug view. 0 normal, 1 keep mask, 2 distance.
   *
   * The keep mask is the one that answers "are we wasting instances": rejected blades
   * normally collapse to a degenerate triangle and vanish, so the pool being 90%
   * discarded looks identical to the pool being the right size. Mode 1 draws every
   * instance regardless and colours it — green kept, magenta rejected — so the waste
   * is visible rather than inferred.
   */
  bladeDebug?: number;
  /** Blade base-to-tip contrast; the tip gets 2 - this. Sweeps how much they read. */
  bladeShade?: number;
  /** Blade brightness against the march behind them. The "do they read" dial. */
  bladeLift?: number;
  /** How far blades lean away from the player, as a fraction of blade height. */
  bladePush?: number;
  /** Radius of that lean, metres. */
  bladePushRadius?: number;
  /** Sun-facing brightness modulation on blades, either side of 1.0. */
  bladeSun?: number;
  /** Per-texel share of the baked height field. Baked, so reload to change. */
  strand?: number;
  /** Longest span a ray searches, metres. Sets step size for grazing rays. */
  maxspan?: number;
  /**
   * Grow full-height grass everywhere, ignoring the canopy field.
   *
   * Two modes, because it serves two jobs. Under `?bench=1` it is ON by default and
   * `?canopyall=0` opts out — a bench number needs the worst case. Without `?bench=1`
   * it is OFF unless `?canopyall=1` asks for it, which is the missing-grass hunt in
   * docs/08 §11 and needs a free camera rather than the bench vantage.
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
  //
  // So is forcing the canopy, and MORE so: docs/08 §11 makes `?canopyall=1` the first
  // move on any missing-grass report, and that is a hunt for a specific place and
  // heading. Reaching it through `?bench=1` pins the camera to the bench vantage, which
  // is the one place you cannot look from. Opt-in only, so a player never sees it.
  const num = (k: string): number | undefined => {
    const v = q.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  // WHICH PARAMETERS ESCAPE THE BENCH GATE, in one object rather than as a rule
  // restated in two return statements. Duplicating the list is how a new dial ends up
  // silently bench-only, which is the exact failure `?canopyall=` was split out to
  // avoid — and a comment saying "read the same way in both branches" is not a
  // mechanism.
  const ungated = {
    debug,
    blades: q.get("blades") === null ? undefined : q.get("blades") !== "0",
    bladeCount: num("bladecount"),
    bladeRadius: num("bladeradius"),
    bladeDebug: num("bladedebug"),
    bladeShade: num("bladeshade"),
    bladeLift: num("bladelift"),
    bladePush: num("bladepush"),
    bladePushRadius: num("bladepushradius"),
    bladeSun: num("bladesun"),
  };

  if (q.get("bench") !== "1") {
    return { enabled: false, ...ungated, canopyAll: q.get("canopyall") === "1" };
  }

  const stance = q.get("stance");

  return {
    enabled: true,
    ...ungated,
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
