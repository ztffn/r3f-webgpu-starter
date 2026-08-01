import assert from "node:assert/strict";
import test from "node:test";
import { AimSwayController, STANCE_SWAY_MULTIPLIER } from "../../src/fps/core/AimSwayController.ts";

test("aim sway is deterministic and clamps frame hitches", () => {
  const hitch = new AimSwayController();
  const clamped = new AimSwayController();
  const input = { stance: "stand" as const, adsBlend: 1, holdingBreath: false };
  hitch.update(10, input);
  clamped.update(0.1, input);

  assert.equal(hitch.phaseSeconds, clamped.phaseSeconds);
  assert.equal(hitch.yawRadians, clamped.yawRadians);
  assert.equal(hitch.pitchRadians, clamped.pitchRadians);
});

test("crouch and prone reduce authoritative angular sway", () => {
  const amplitudes = (["stand", "crouch", "prone"] as const).map((stance) => {
    const sway = new AimSwayController();
    sway.update(1 / 60, { stance, adsBlend: 1, holdingBreath: false });
    return sway.angularAmplitudeRadians;
  });

  assert.ok(amplitudes[0] > amplitudes[1]);
  assert.ok(amplitudes[1] > amplitudes[2]);
  assert.equal(amplitudes[1] / amplitudes[0], STANCE_SWAY_MULTIPLIER.crouch);
  assert.equal(amplitudes[2] / amplitudes[0], STANCE_SWAY_MULTIPLIER.prone);
});

test("holding breath smoothly reduces sway rather than snapping", () => {
  const sway = new AimSwayController();
  sway.update(1 / 60, { stance: "prone", adsBlend: 1, holdingBreath: false });
  const initial = sway.angularAmplitudeRadians;
  sway.update(1 / 60, { stance: "prone", adsBlend: 1, holdingBreath: true });
  const firstHeldFrame = sway.angularAmplitudeRadians;
  for (let frame = 0; frame < 60; frame += 1) {
    sway.update(1 / 60, { stance: "prone", adsBlend: 1, holdingBreath: true });
  }

  assert.ok(firstHeldFrame < initial);
  assert.ok(firstHeldFrame > sway.angularAmplitudeRadians);
  assert.ok(sway.breathStabilization > 0.99);
  assert.ok(sway.angularAmplitudeRadians < initial * 0.25);
});
