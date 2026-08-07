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
  /**
   * Force a water level in world metres — `?water=120`.
   *
   * Every .trn in this pack ships `water_height` 0, which sits below the terrain's own
   * minimum, so the water plane never draws and nothing downstream of it has ever run.
   * That includes the ground fog's underwater use, which is the same term with its level
   * set to the surface, and the precipitation system's submerged morph.
   */
  water?: number;
  /**
   * Fog layer overrides, world metres and per-metre extinction — `?fogbase=`,
   * `?fogtop=`, `?fogdensity=`.
   *
   * The panel has all three, but a fog band is a POSE as much as a setting: it only
   * reads from a vantage where the layer cuts the terrain, so it needs to be reachable
   * in the same URL that fixes the camera.
   */
  fogBase?: number;
  fogTop?: number;
  fogDensity?: number;
  /**
   * Distance fog range in metres — `?fognear=10&fogfar=350`.
   *
   * Here because a short range is where the haze is stressed hardest: it drives the term
   * to full on terrain that is still well BELOW eye level, which is the geometry that
   * exposed the haze sampling the skybox's baked ground. That case was reachable only by
   * dragging two panel sliders, so it could be shown but not reproduced.
   */
  fogNear?: number;
  fogFar?: number;
  /**
   * Drop a smoke volume this many metres ahead of the eye at load — `?smoke=15`.
   *
   * A thrown puff cannot be screenshotted twice the same way, and smoke is judged
   * entirely on how it sits against terrain at a given range.
   */
  smoke?: number;
  /** Precipitation independent of the preset — `?rain=0.8&snow=1`. */
  rain?: number;
  snow?: number;
  /**
   * The rain box — `?raincount=`, `?rainarea=`, `?rainheight=`.
   *
   * Drops exist only inside a box centred on the camera, so `rainarea` is where rain
   * visibly stops. Widening it at a fixed count thins the rain, since the added volume is
   * almost all far drops that are sub-pixel; raise the count with it.
   */
  rainCount?: number;
  rainArea?: number;
  rainHeight?: number;
  /**
   * Terrain scale dials — `?texel=1&hscale=0.5&hsmooth=2`. World metres per heightmap
   * texel, metres per raw 8-bit elevation unit, and terracing smooth passes.
   *
   * BOTH scales are calibrated now (config.ts — texel 2026-08-06, height scale
   * 2026-08-07 from the mission-editor manual's 1/2 m), so these are A/B
   * instruments rather than open questions, kept for the next map format or a
   * disputed measurement. The whole world builds from these (chunks, motor
   * terrain, grass placement), so they are baked at load — reload to change —
   * and OFFLINE dials only: a networked session's server simulates the config
   * scale, and a client dialled away from it would disagree with every
   * authoritative position. GameApp enforces both halves of that: it ignores
   * these seeds when networked and clamps them to TERRAIN_SCALE_LIMITS offline.
   */
  texel?: number;
  heightScale?: number;
  heightSmooth?: number;
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
  /**
   * Draw the vegetation layer — bushes and trees, not grass.
   *
   * OPT-IN and independent of `?bench=1`, following the precedent `?debug=1` and
   * `?canopyall=1` set: this is an exploratory subsystem, and switching it on by default
   * would change every existing frame time and every existing screenshot for everyone
   * looking at grass. The knobs below only mean anything with it on.
   */
  foliage?: boolean;
  /** Card construction under test: A broad / B trimmed / C hybrid / D geometry. */
  foliageVariant?: string;
  /** mask | a2c | hash | blend. */
  foliageAlpha?: string;
  /** Cell side in metres — the draw-call / culling / LOD-granularity dial. */
  foliageCell?: number;
  /** Global density multiplier. */
  foliageDensity?: number;
  /** Window reach in METRES. Cells follow from it, so a cell sweep holds the reach. */
  foliageRadius?: number;
  /**
   * `?admin=1` — unlock the dev controls a NETWORKED session otherwise suppresses.
   *
   * WHAT IT IS NOT: server authority. The client already sends dial changes upward and
   * the server refuses them unless it was started with `DF2_ADMIN=1`; a URL parameter
   * cannot change that and must not be able to, because a flag anyone types is not a
   * credential. This only says "show me the controls and let them act locally", so the
   * division is URL reveals UI, server enforces authority.
   *
   * Local action on a gameplay quantity is still a fairness statement: growing yourself
   * twice the cover changes what you can hide behind. Acceptable for a development
   * instrument on a session you own, which is why the panel labels it rather than
   * pretending the value is shared.
   */
  admin?: boolean;
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
    texel: num("texel"),
    heightScale: num("hscale"),
    heightSmooth: num("hsmooth"),
    water: num("water"),
    fogBase: num("fogbase"),
    fogTop: num("fogtop"),
    fogDensity: num("fogdensity"),
    fogNear: num("fognear"),
    fogFar: num("fogfar"),
    smoke: num("smoke"),
    rain: num("rain"),
    snow: num("snow"),
    rainCount: num("raincount"),
    rainArea: num("rainarea"),
    rainHeight: num("rainheight"),
    foliage: q.get("foliage") === "1",
    foliageVariant: q.get("foliagevariant") ?? undefined,
    foliageAlpha: q.get("foliagealpha") ?? undefined,
    foliageCell: num("foliagecell"),
    foliageDensity: num("foliagedensity"),
    foliageRadius: num("foliageradius"),
    admin: q.get("admin") === "1",
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

/**
 * Vegetation counters, published whenever the layer is on.
 *
 * Separate from `BenchSample` and not gated on `?bench=1`: a foliage number is only
 * meaningful next to the configuration that produced it, and the configuration is
 * reachable without the fixed bench vantage — the card-variant comparison in particular
 * has to be run from several poses, which `?bench=1` pins you out of (docs/08 §11).
 */
export interface FoliageBenchSample {
  variant: string;
  alphaMode: string;
  cellSize: number;
  radiusMetres: number;
  visibleBuckets: number;
  visibleInstances: number;
  trianglesIfAllDrawn: number;
  cellsCached: number;
  pendingBuckets: number;
  /** Texels passing the alpha cutoff at mip 0 — the research memo's cost metric. */
  alphaOccupancy: number;
  /** Coverage per mip level; should track level 0, or the silhouette thins with range. */
  levelCoverage: number[];
}

declare global {
  interface Window {
    __perf?: BenchSample;
    __foliage?: FoliageBenchSample;
    __terrain?: { pendingChunks: number };
  }
}

export function publish(sample: BenchSample): void {
  if (BENCH.enabled) window.__perf = sample;
}

export function publishFoliage(sample: FoliageBenchSample): void {
  window.__foliage = sample;
}

/**
 * Chunks still waiting on the terrain build budget.
 *
 * Published so a measurement rig can tell a FINISHED world from one that is still
 * filling in. Inferring it from a stable draw-call count does not work: chunk building is
 * budgeted per FRAME, so at a few frames per second it advances a few milliseconds per
 * second and the draw count sits still for long stretches with chunks plainly missing. A
 * grass-on/grass-off comparison taken that way reported 175 draw calls against 244 and was
 * measuring two different amounts of world, not two configurations.
 *
 * Ungated: it costs one number per frame and it is the only honest completion signal.
 */
export function publishTerrain(pendingChunks: number): void {
  window.__terrain = { pendingChunks };
}
