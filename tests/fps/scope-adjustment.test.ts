import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three/webgpu";
import type { BallisticEnvironment } from "../../src/combat/BallisticEnvironment.ts";
import {
  ScopeAdjustmentController,
  SCOPE_ZERO_DISTANCES_METRES,
  WINDAGE_CLICK_RADIANS,
  predictBallisticAtSightRange,
  scopeAdjustmentActionForKey,
  solveElevationZeroRadians,
} from "../../src/fps/core/ScopeAdjustmentController.ts";
import { AMMUNITION_DEFINITIONS } from "../../src/combat/AmmunitionDefinition.ts";

const PROFILE = {
  muzzleVelocityMetresPerSecond: 792.48,
  ballisticCoefficientG1: 0.505,
};

const STILL_AIR: BallisticEnvironment = {
  gravity: { x: 0, y: -9.80665, z: 0 },
  windVelocity: { x: 0, y: 0, z: 0 },
  fixedStepSeconds: 1 / 120,
  maxCatchUpSeconds: 0.25,
};

test("every 100–1300 m elevation preset crosses the sightline", () => {
  for (const range of SCOPE_ZERO_DISTANCES_METRES) {
    const elevation = solveElevationZeroRadians(PROFILE, STILL_AIR, range);
    const prediction = predictBallisticAtSightRange(PROFILE, STILL_AIR, range, elevation);
    assert.ok(elevation > 0);
    assert.ok(
      Math.abs(prediction.verticalOffsetMetres) < 0.001,
      `${range} m zero missed sightline by ${prediction.verticalOffsetMetres} m`
    );
  }
});

test("low-velocity ammunition uses only zeros reachable within weapon lifetime", () => {
  const pistolProfile = AMMUNITION_DEFINITIONS["9mm"];
  const elevation800 = solveElevationZeroRadians(pistolProfile, STILL_AIR, 800);
  const prediction800 = predictBallisticAtSightRange(
    pistolProfile,
    STILL_AIR,
    800,
    elevation800
  );
  assert.ok(Math.abs(prediction800.verticalOffsetMetres) < 0.001);

  const controller = new ScopeAdjustmentController(pistolProfile, STILL_AIR, 3.5);
  for (let step = 0; step < SCOPE_ZERO_DISTANCES_METRES.length; step += 1) {
    controller.apply("elevation-up");
  }
  assert.equal(controller.getSnapshot().zeroDistanceMetres, 500);
});

test("turret clicks are bounded, symmetric, and resettable", () => {
  const controller = new ScopeAdjustmentController(PROFILE, STILL_AIR);
  assert.equal(controller.getSnapshot().zeroDistanceMetres, 100);
  assert.equal(controller.apply("elevation-up"), true);
  assert.equal(controller.getSnapshot().zeroDistanceMetres, 200);
  assert.equal(controller.apply("windage-right"), true);
  assert.equal(controller.getSnapshot().windageMilliradians, 0.1);

  const rightBore = controller.applyToSightDirection(new Vector3(0, 0, -1), new Vector3());
  assert.ok(rightBore.x > 0);
  assert.ok(Math.abs(Math.atan2(rightBore.x, -rightBore.z) - WINDAGE_CLICK_RADIANS) < 1e-9);
  assert.ok(rightBore.y > 0, "elevation zero raises the bore above the sightline");

  controller.apply("windage-left");
  assert.equal(controller.getSnapshot().windageMilliradians, 0);
  controller.apply("windage-left");
  const leftBore = controller.applyToSightDirection(new Vector3(0, 0, -1), new Vector3());
  assert.ok(leftBore.x < 0);
  assert.ok(Math.abs(rightBore.x + leftBore.x) < 1e-7);

  controller.apply("reset");
  assert.equal(controller.getSnapshot().zeroDistanceMetres, 100);
  assert.equal(controller.getSnapshot().windageMilliradians, 0);
});

test("compact and full-keyboard bindings map to the same turret actions", () => {
  assert.equal(scopeAdjustmentActionForKey({ code: "ArrowUp", key: "ArrowUp" }), "elevation-up");
  assert.equal(scopeAdjustmentActionForKey({ code: "PageUp", key: "PageUp" }), "elevation-up");
  assert.equal(scopeAdjustmentActionForKey({ code: "ArrowLeft", key: "ArrowLeft" }), "windage-left");
  assert.equal(scopeAdjustmentActionForKey({ code: "Digit0", key: "0" }), "reset");
  assert.equal(scopeAdjustmentActionForKey({ code: "KeyW", key: "w" }), null);
});
