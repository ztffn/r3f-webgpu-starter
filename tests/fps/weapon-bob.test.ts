// Covers the weapon bob's two load-bearing properties: that it is driven by distance
// rather than by the clock, and that it settles rather than snapping.
//
// The frame-rate test is the one with teeth. Bob phase accumulated from elapsed time
// looks correct at whatever rate it was written on and drifts at every other, which shows
// up as the gait changing speed on a faster machine — a bug nothing else here would catch.

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WEAPON_BOB, WeaponBobController } from "../../src/fps/presentation/WeaponBob.ts";

/** Run one controller for `seconds` at a fixed rate, at a constant speed. */
function run(hz: number, seconds: number, speed = 3.2): WeaponBobController {
  const bob = new WeaponBobController();
  const dt = 1 / hz;
  // A fixed STEP COUNT, not a `t < seconds` accumulator. Accumulating floats runs a
  // different number of steps per rate and therefore a different total distance, which
  // then fails a distance-driven bob for the one reason that is not its fault.
  const steps = Math.round(seconds * hz);
  for (let i = 0; i < steps; i += 1) bob.update(dt, speed, true);
  return bob;
}

test("bob phase depends on distance travelled, not on frame rate", () => {
  // The exact invariant. Phase is the figure the weapon traces; identical distance must
  // give identical phase at any rate, and a time-driven implementation would not.
  const rates = [30, 60, 144, 240].map((hz) => run(hz, 4));
  for (const bob of rates) {
    assert.ok(
      Math.abs(bob.phaseTurns - rates[0].phaseTurns) < 1e-9,
      `phase diverged: ${bob.phaseTurns} vs ${rates[0].phaseTurns}`
    );
  }
});

test("the bob a player sees barely moves with frame rate", () => {
  // Tight now that the figure is written out unfiltered: the only remaining step-size
  // sensitivity is the slow amplitude envelope, which has long settled by four seconds.
  const at30 = run(30, 4);
  const at240 = run(240, 4);
  assert.ok(
    Math.abs(at30.offsetX - at240.offsetX) < DEFAULT_WEAPON_BOB.walk.lateralMetres * 0.02,
    `lateral diverged too far (${at30.offsetX} vs ${at240.offsetX})`
  );
  assert.ok(
    Math.abs(at30.offsetY - at240.offsetY) < DEFAULT_WEAPON_BOB.walk.verticalMetres * 0.02,
    `vertical diverged too far (${at30.offsetY} vs ${at240.offsetY})`
  );
});

test("standing still lets the bob settle back to nothing", () => {
  const bob = run(60, 2);
  assert.ok(Math.abs(bob.offsetX) > 0, "expected a moving player to bob at all");
  for (let i = 0; i < 60 * 3; i += 1) bob.update(1 / 60, 0, true);
  assert.ok(Math.abs(bob.offsetX) < 1e-4, `lateral did not settle: ${bob.offsetX}`);
  assert.ok(Math.abs(bob.offsetY) < 1e-4, `vertical did not settle: ${bob.offsetY}`);
});

test("leaving the ground fades the bob out instead of cutting it", () => {
  const bob = run(60, 2);
  const airborneFirstFrame = { x: bob.offsetX, y: bob.offsetY };
  bob.update(1 / 60, 3.2, false);
  // One frame off the ground must not zero it — that would read as a hitch on every jump.
  assert.ok(
    Math.abs(bob.offsetX - airborneFirstFrame.x) < 0.01,
    "bob jumped discontinuously when the player left the ground"
  );
  for (let i = 0; i < 60 * 3; i += 1) bob.update(1 / 60, 3.2, false);
  assert.ok(Math.abs(bob.offsetY) < 1e-3, "airborne bob should decay to nothing");
});

test("going faster lengthens the stride rather than only quickening it", () => {
  // The "baby steps" failure: with one fixed stride, every extra metre per second becomes
  // cadence and a run reads as a fast shuffle. Over the SAME GROUND a runner must
  // therefore take fewer strides than a walker.
  const distance = 40;
  const dt = 1 / 240;
  const cycles = (speed: number) => {
    const bob = new WeaponBobController();
    let travelled = 0;
    let turns = 0;
    let previous = 0;
    while (travelled < distance) {
      bob.update(dt, speed, true);
      travelled += speed * dt;
      if (bob.phaseTurns < previous) turns += 1;
      previous = bob.phaseTurns;
    }
    return turns;
  };
  const walking = cycles(1.6);
  const running = cycles(6);
  assert.ok(
    running < walking,
    `running (${running} strides) should out-stride walking (${walking}) over ${distance} m`
  );
});

test("cadence stays inside the bounds that stop a shuffle", () => {
  // The clamp that makes the "baby steps" bug unreintroducible by a future speed change.
  for (const speed of [0.5, 1.6, 3.2, 6, 12, 30]) {
    const bob = new WeaponBobController();
    const dt = 1 / 240;
    let turns = 0;
    let previous = 0;
    for (let i = 0; i < 240; i += 1) {
      bob.update(dt, speed, true);
      if (bob.phaseTurns < previous) turns += 1;
      previous = bob.phaseTurns;
    }
    const stepsPerSecond = turns * 2;
    assert.ok(
      stepsPerSecond <= DEFAULT_WEAPON_BOB.maxStepsPerSecond + 0.5,
      `${speed} m/s produced ${stepsPerSecond} footfalls/s, above the clamp`
    );
  }
});

test("aiming quiets the bob so the sight picture can hold still", () => {
  const hip = new WeaponBobController();
  const ads = new WeaponBobController();
  const dt = 1 / 240;
  for (let i = 0; i < 240 * 4; i += 1) {
    hip.update(dt, 3.2, true, 0);
    ads.update(dt, 3.2, true, 1);
  }
  let hipPeak = 0;
  let adsPeak = 0;
  for (let i = 0; i < 240 * 2; i += 1) {
    hip.update(dt, 3.2, true, 0);
    ads.update(dt, 3.2, true, 1);
    hipPeak = Math.max(hipPeak, Math.abs(hip.offsetX));
    adsPeak = Math.max(adsPeak, Math.abs(ads.offsetX));
  }
  assert.ok(adsPeak < hipPeak * 0.35, `aimed bob ${adsPeak} not quieted against hip ${hipPeak}`);
});

test("the authored amplitude is the amplitude the player actually gets", () => {
  // The regression that motivated removing the follow filter. Damping the figure cost the
  // vertical 77% of its travel while barely touching the lateral, because the vertical
  // runs four times faster and a low-pass is frequency-selective — so a tuned number and
  // a rendered number were different things. Both axes must now arrive intact.
  const bob = new WeaponBobController();
  const dt = 1 / 240;
  for (let i = 0; i < 240 * 4; i += 1) bob.update(dt, 3.2, true);
  let lateral = 0;
  let verticalMin = Infinity;
  let verticalMax = -Infinity;
  for (let i = 0; i < 240 * 3; i += 1) {
    bob.update(dt, 3.2, true);
    lateral = Math.max(lateral, Math.abs(bob.offsetX));
    verticalMin = Math.min(verticalMin, bob.offsetY);
    verticalMax = Math.max(verticalMax, bob.offsetY);
  }
  assert.ok(
    lateral > DEFAULT_WEAPON_BOB.walk.lateralMetres * 0.98,
    `lateral lost travel: ${lateral} vs ${DEFAULT_WEAPON_BOB.walk.lateralMetres}`
  );
  assert.ok(
    verticalMax - verticalMin > DEFAULT_WEAPON_BOB.walk.verticalMetres * 0.98,
    `vertical lost travel: ${verticalMax - verticalMin} vs ${DEFAULT_WEAPON_BOB.walk.verticalMetres}`
  );
});

test("the vertical component runs at twice the lateral frequency", () => {
  // One full lateral cycle is metresPerCycle of travel; the vertical dips twice in it.
  const bob = new WeaponBobController();
  const dt = 1 / 240;
  const speed = 3.2;
  let lateralSignChanges = 0;
  let verticalSignChanges = 0;
  let previousLateral = 0;
  let previousVertical = 0;
  // Skip the fade-in so the sign changes counted are the steady-state gait.
  for (let i = 0; i < 240 * 4; i += 1) bob.update(dt, speed, true);
  const distanceForOneCycle = DEFAULT_WEAPON_BOB.walk.metresPerCycle;
  const steps = Math.round(distanceForOneCycle / (speed * dt));
  for (let i = 0; i < steps; i += 1) {
    bob.update(dt, speed, true);
    const lateral = bob.offsetX;
    const vertical = bob.offsetY;
    if (i > 0 && Math.sign(lateral) !== Math.sign(previousLateral)) lateralSignChanges += 1;
    if (i > 0 && Math.sign(vertical) !== Math.sign(previousVertical)) verticalSignChanges += 1;
    previousLateral = lateral;
    previousVertical = vertical;
  }
  assert.ok(
    verticalSignChanges > lateralSignChanges,
    `vertical (${verticalSignChanges}) should oscillate faster than lateral (${lateralSignChanges})`
  );
});
