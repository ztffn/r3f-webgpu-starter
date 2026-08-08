// Frame-time distribution tests.
//
// The properties pinned here are the ones the sampler this replaced got wrong: a spike
// must survive a report, a long pause must be counted rather than dropped, and the
// histogram must account for every recorded frame exactly once.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BUCKET_EDGES_MS,
  HITCH_MS,
  PAUSE_MS,
  STALL_MS,
  createFrameStats,
} from "../../src/df2/frameStats.ts";

test("a spike survives a report, which is the whole reason this module exists", () => {
  const stats = createFrameStats();
  for (let i = 0; i < 100; i += 1) stats.record(8);
  stats.record(180);

  const first = stats.report();
  assert.equal(first.worstMs, 180, "window worst sees the spike");
  assert.equal(first.worstEverMs, 180);
  assert.equal(first.hitches, 1);

  // The window resets; the cumulative record does not. The old sampler zeroed its only
  // worst-frame figure here, so a hitch was visible for one interval and then gone.
  for (let i = 0; i < 100; i += 1) stats.record(8);
  const second = stats.report();
  assert.equal(second.worstMs, 8, "window worst has reset");
  assert.equal(second.worstEverMs, 180, "worst-since-load has NOT reset");
  assert.equal(second.hitches, 1, "the hitch is still counted");
});

test("a pause is counted, not discarded, and does not pollute the mean", () => {
  const stats = createFrameStats();
  for (let i = 0; i < 99; i += 1) stats.record(10);
  stats.record(PAUSE_MS + 5000);

  const report = stats.report();
  assert.equal(report.pauses, 1);
  assert.equal(report.frames, 99, "a pause is not a rendered frame");
  assert.equal(report.meanMs, 10, "a tab switch cannot own the mean");
  assert.equal(report.worstEverMs, 10, "nor the worst frame");
  // And it is still visible. A dropped event cannot be told apart from one that never
  // happened, which is exactly how the snag went unexplained.
  assert.ok(report.pauses > 0);
});

test("the histogram accounts for every frame exactly once", () => {
  const stats = createFrameStats();
  const samples = [1, 8, 8.4, 17, 20, 34, 60, 120, 300, 1500];
  for (const s of samples) stats.record(s);

  const report = stats.report();
  const total = report.buckets.reduce((a, b) => a + b, 0);
  assert.equal(report.buckets.length, BUCKET_EDGES_MS.length);
  assert.equal(total, samples.length, "every frame landed in exactly one bucket");
  assert.equal(total, report.frames);
});

test("hitch and stall thresholds are what they claim, at the boundary", () => {
  const stats = createFrameStats();
  stats.record(HITCH_MS);
  stats.record(HITCH_MS + 0.1);
  stats.record(STALL_MS + 0.1);

  const report = stats.report();
  // Strictly greater than, so a frame exactly at the threshold is not a hitch.
  assert.equal(report.hitches, 2, "one over the hitch line, plus the stall");
  assert.equal(report.stalls, 1);
});

test("percentiles come from the retained ring, not the reporting window", () => {
  const stats = createFrameStats(1000);
  // 990 good frames and 10 bad ones: the 99th percentile must find the bad tail.
  for (let i = 0; i < 990; i += 1) stats.record(10);
  for (let i = 0; i < 10; i += 1) stats.record(100);

  const report = stats.report();
  assert.equal(report.p50Ms, 10);
  assert.equal(report.p99Ms, 100, "the worst 1% is the tail, not the mean");

  // A later window of only good frames must not erase the tail — the ring still holds it.
  for (let i = 0; i < 5; i += 1) stats.record(10);
  const later = stats.report();
  assert.equal(later.windowFrames, 5);
  assert.equal(later.p99Ms, 100, "a short window cannot compute a 99th percentile alone");
});

test("the ring forgets in order, so percentiles track the recent past", () => {
  const stats = createFrameStats(10);
  for (let i = 0; i < 10; i += 1) stats.record(100);
  assert.equal(stats.report().p50Ms, 100);
  // Overwrite the whole ring with good frames; the old spike must age out of the
  // percentiles while remaining in the cumulative counters.
  for (let i = 0; i < 10; i += 1) stats.record(5);
  const report = stats.report();
  assert.equal(report.p50Ms, 5, "percentiles describe the recent past");
  assert.equal(report.worstEverMs, 100, "the record of the spike is permanent");
  assert.equal(report.hitches, 10);
});

test("reset clears everything, for a rig starting a measured run", () => {
  const stats = createFrameStats();
  stats.record(500);
  stats.reset();
  const report = stats.report();
  assert.equal(report.frames, 0);
  assert.equal(report.worstEverMs, 0);
  assert.equal(report.hitches, 0);
  assert.equal(report.stalls, 0);
  assert.equal(
    report.buckets.reduce((a, b) => a + b, 0),
    0
  );
});
