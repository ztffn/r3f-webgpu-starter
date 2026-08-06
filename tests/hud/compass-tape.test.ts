// Compass tape geometry.
//
// These assertions exist because the compass is driven by requestAnimationFrame,
// and rAF does not fire in a headless or backgrounded browser tab — so "the tape
// points the right way" could not be checked where this project does its checking.
// The arithmetic is pure (src/hud/compassTape.ts), so it is pinned here instead.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LABEL_DEGREES,
  PX_PER_DEGREE,
  TAPE_DEGREES,
  TICK_DEGREES,
  buildTicks,
  tapeOffsetPx,
  tickScreenOffset,
} from "../../src/hud/compassTape.ts";
import { headingFromYaw } from "../../src/hud/hudSignals.ts";

const TICKS = buildTicks();

/** The tick on the CENTRE turn for a bearing — the one that should be indexed. */
function centreTurnTick(bearing: number) {
  const tick = TICKS.find((t) => t.absolute === bearing + 360);
  assert.ok(tick, `no centre-turn tick for bearing ${bearing}`);
  return tick;
}

describe("compass tape", () => {
  it("spans three turns at one tick per 5 degrees", () => {
    assert.equal(TICKS.length, TAPE_DEGREES / TICK_DEGREES);
    assert.equal(TICKS.length, 216);
    assert.equal(TICKS[0]!.absolute, 0);
    assert.equal(TICKS.at(-1)!.absolute, TAPE_DEGREES - TICK_DEGREES);
  });

  it("puts the heading's own tick exactly under the index mark", () => {
    // The property the whole component rests on: at any heading, the tick for
    // that bearing sits at zero offset from the window centre.
    for (const bearing of [0, 5, 90, 180, 270, 285, 355]) {
      assert.equal(
        tickScreenOffset(centreTurnTick(bearing), bearing),
        0,
        `bearing ${bearing} is not indexed`
      );
    }
  });

  it("places lower bearings to the left and higher to the right", () => {
    // A compass that is mirrored still indexes correctly, so direction needs its
    // own assertion — this is the failure that looks plausible in a screenshot.
    const heading = 180;
    assert.ok(tickScreenOffset(centreTurnTick(150), heading) < 0, "150 should be left of S");
    assert.ok(tickScreenOffset(centreTurnTick(210), heading) > 0, "210 should be right of S");
    assert.equal(
      tickScreenOffset(centreTurnTick(210), heading),
      30 * PX_PER_DEGREE,
      "30 degrees right should be 30 * PX_PER_DEGREE away"
    );
  });

  it("keeps a full turn of tape beyond the index in both directions", () => {
    // This is why the tape is three turns: the wrap must never be visible.
    for (const heading of [0, 359]) {
      const offset = tapeOffsetPx(heading);
      const first = TICKS[0]!.offsetPx + offset;
      const last = TICKS.at(-1)!.offsetPx + offset;
      assert.ok(first <= -360 * PX_PER_DEGREE, `heading ${heading} has no tape to the left`);
      assert.ok(last >= 355 * PX_PER_DEGREE, `heading ${heading} has no tape to the right`);
    }
  });

  it("labels the four cardinals and every LABEL_DEGREES step, and nothing else", () => {
    const labelled = TICKS.filter((t) => t.label !== null);
    assert.equal(labelled.length, TAPE_DEGREES / LABEL_DEGREES);
    assert.equal(centreTurnTick(0).label, "N");
    assert.equal(centreTurnTick(90).label, "E");
    assert.equal(centreTurnTick(180).label, "S");
    assert.equal(centreTurnTick(270).label, "W");
    assert.equal(centreTurnTick(330).label, "330");
    // 5° is a tick but must not carry a number, or the strip becomes a texture.
    assert.equal(centreTurnTick(5).label, null);
  });

  it("derives a compass heading from the rigs' yaw convention", () => {
    // Both FlyControls and MotorControls build forward as (-sin yaw, ·, -cos yaw),
    // so yaw 0 looks down -Z, which is north. Turning screen-right lowers yaw and
    // must RAISE the bearing — the sign error here is the one that produces a
    // compass that counts backwards.
    assert.equal(headingFromYaw(0), 0);
    const quarter = Math.PI / 2;
    assert.ok(
      Math.abs(headingFromYaw(-quarter) - quarter) < 1e-9,
      "turning right should raise the bearing towards east"
    );
    assert.ok(
      Math.abs(headingFromYaw(quarter) - (Math.PI * 2 - quarter)) < 1e-9,
      "turning left should lower the bearing towards west"
    );
    // Always normalised into [0, 2pi), however many turns the rig has accumulated.
    for (const yaw of [-40, -7, 0, 7, 40]) {
      const heading = headingFromYaw(yaw);
      assert.ok(heading >= 0 && heading < Math.PI * 2, `yaw ${yaw} left range`);
    }
  });
});
