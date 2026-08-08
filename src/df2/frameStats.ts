// Frame-time distribution: percentiles, a cumulative histogram and hitch counters.
//
// Exists because a mean and a per-window peak cannot answer "did it stutter while I
// looked around". The previous sampler reset its worst frame every 500 ms, so a spike
// was displayed for half a second and then erased, and it discarded frames over 1 s
// outright — deleting the loudest event on purpose. Nothing here is ever reset by a
// report, and nothing is discarded silently.
//
// Pure: no Three.js, no React, no DOM. It takes deltas and answers questions, which is
// what makes it testable in Node and reusable by the headless rigs.

/**
 * Histogram edges in MILLISECONDS, upper-exclusive, last bucket unbounded.
 *
 * Aligned to the vsync cadences `docs/09` already reasons in — 8.33 ms is the 120 Hz cap
 * and 16.7 ms the 60 Hz one — so a reader who knows that document can read a bucket
 * without a conversion. The histogram is the point: it means the two threshold counters
 * below are conveniences rather than the only available answer, and anyone can apply a
 * different threshold to the same run afterwards.
 */
export const BUCKET_EDGES_MS: readonly number[] = [8.33, 16.7, 33.3, 50, 100, 250, 1000, Infinity];

/**
 * A frame worse than this counts as a HITCH — visibly not smooth at any refresh rate
 * this project targets, since 33.3 ms is 30 fps.
 *
 * INDEXED OUT OF THE EDGES rather than written again, so the threshold and the histogram
 * bucket it corresponds to cannot drift apart when someone retunes the edges.
 */
export const HITCH_MS = BUCKET_EDGES_MS[2];

/** A frame worse than this counts as a STALL — long enough to read as a freeze. */
export const STALL_MS = BUCKET_EDGES_MS[5];

/**
 * A frame worse than this is a PAUSE, not a rendering cost: a background tab, a
 * breakpoint, a laptop lid. Counted separately and excluded from the mean and the
 * percentiles, because a 30-second tab switch would otherwise own every statistic.
 *
 * Counted rather than dropped, which is the difference from the sampler this replaces.
 * A discarded event is indistinguishable from an event that never happened.
 */
export const PAUSE_MS = 2000;

export interface FrameStatsReport {
  /** Frames measured in the window just closed. */
  windowFrames: number;
  /** Mean frame time over that window, ms. What "fps" is derived from. */
  meanMs: number;
  /** Worst frame in that window, ms. */
  worstMs: number;
  /**
   * Median and 99th percentile over the RETAINED RING, not the window — a 500 ms window
   * holds too few frames for a 99th percentile to mean anything.
   */
  p50Ms: number;
  p99Ms: number;
  /** Worst frame SINCE LOAD, never reset. The number a hitch report actually needs. */
  worstEverMs: number;
  /** Cumulative since load, all of them. */
  frames: number;
  hitches: number;
  stalls: number;
  pauses: number;
  /** Cumulative counts, parallel to `BUCKET_EDGES_MS`. */
  buckets: readonly number[];
}

export interface FrameStats {
  /** Record one frame delta in milliseconds. */
  record(deltaMs: number): void;
  /**
   * Read the statistics AND close the current window.
   *
   * Only the window-scoped fields reset — `meanMs`, `worstMs` and `windowFrames`.
   * Everything cumulative survives, which is the whole reason this module exists.
   */
  report(): FrameStatsReport;
  /** Full reset, including the cumulative counters. For a rig starting a measured run. */
  reset(): void;
}

/**
 * @param ringSize How many recent deltas the percentiles are computed over. 2048 frames
 *   is 17 s at 120 fps and 34 s at 60 — long enough that a 99th percentile describes
 *   "this vantage" rather than "this instant", short enough that it still moves when the
 *   camera does.
 */
export function createFrameStats(ringSize = 2048): FrameStats {
  const ring = new Float32Array(ringSize);
  let ringCount = 0;
  let ringNext = 0;
  const buckets = new Array<number>(BUCKET_EDGES_MS.length).fill(0);

  let frames = 0;
  let hitches = 0;
  let stalls = 0;
  let pauses = 0;
  let worstEver = 0;

  let windowFrames = 0;
  let windowTotal = 0;
  let windowWorst = 0;

  // Scratch for the percentile sort, allocated once. Sorting happens twice a second at
  // most, but allocating 8 kB on the frame path to do it would be its own small hitch.
  const scratch = new Float32Array(ringSize);

  /**
   * Sort the retained ring into `scratch` ONCE and return the filled view.
   *
   * One sort per report, not one per percentile: p50 and p99 are two order statistics of
   * the same sample, and sorting twice copied 8 kB and ran ~22k comparisons for nothing.
   * A profiler that adds avoidable cost to itself is the wrong example to set.
   */
  const sortRing = (): Float32Array | null => {
    if (ringCount === 0) return null;
    scratch.set(ring.subarray(0, ringCount));
    const view = scratch.subarray(0, ringCount);
    view.sort();
    return view;
  };

  /**
   * `floor(p * n)`, NOT `ceil(p * n) - 1`, and the difference is not academic: with
   * exactly 1% bad frames — 990 good and 10 bad — the second form lands on index 989,
   * the last GOOD frame, and reports a p99 of 10 ms for a run that hitched ten times.
   * This form indexes the first frame of the tail, which is what "one frame in a
   * hundred is at least this bad" has to mean to be worth reading. Caught by
   * tests/df2/frame-stats.test.ts on exactly that distribution.
   *
   * No interpolation: these are frame times a person reads before deciding whether to
   * investigate, and an interpolated percentile implies precision the sample lacks.
   */
  const at = (sorted: Float32Array | null, fraction: number): number => {
    if (sorted === null) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
    return sorted[index];
  };

  return {
    record(deltaMs) {
      if (!Number.isFinite(deltaMs) || deltaMs < 0) return;

      if (deltaMs >= PAUSE_MS) {
        pauses += 1;
        return;
      }

      frames += 1;
      if (deltaMs > worstEver) worstEver = deltaMs;
      if (deltaMs > HITCH_MS) hitches += 1;
      if (deltaMs > STALL_MS) stalls += 1;

      for (let i = 0; i < BUCKET_EDGES_MS.length; i += 1) {
        if (deltaMs < BUCKET_EDGES_MS[i]) {
          buckets[i] += 1;
          break;
        }
      }

      ring[ringNext] = deltaMs;
      ringNext = (ringNext + 1) % ringSize;
      if (ringCount < ringSize) ringCount += 1;

      windowFrames += 1;
      windowTotal += deltaMs;
      if (deltaMs > windowWorst) windowWorst = deltaMs;
    },

    report() {
      const sorted = sortRing();
      const out: FrameStatsReport = {
        windowFrames,
        meanMs: windowFrames > 0 ? windowTotal / windowFrames : 0,
        worstMs: windowWorst,
        p50Ms: at(sorted, 0.5),
        p99Ms: at(sorted, 0.99),
        worstEverMs: worstEver,
        frames,
        hitches,
        stalls,
        pauses,
        buckets: buckets.slice(),
      };
      windowFrames = 0;
      windowTotal = 0;
      windowWorst = 0;
      return out;
    },

    reset() {
      ringCount = 0;
      ringNext = 0;
      buckets.fill(0);
      frames = 0;
      hitches = 0;
      stalls = 0;
      pauses = 0;
      worstEver = 0;
      windowFrames = 0;
      windowTotal = 0;
      windowWorst = 0;
    },
  };
}
