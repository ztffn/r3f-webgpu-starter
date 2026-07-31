import assert from "node:assert/strict";
import test from "node:test";
import {
  AIM_DIAGNOSTIC_RANGE_METRES,
  DEFAULT_MOUSE_SENSITIVITY,
  DEFAULT_SCOPE_PRECISION_SCALE,
  LookSensitivityController,
  opticFovSensitivityRatio,
  parseMouseAimConfig,
} from "../../src/fps/core/LookSensitivityController.ts";

test("scope sensitivity meets the 5 cm default-optic bound at 1300 m", () => {
  const look = new LookSensitivityController();
  look.setOpticState(1, 60, 5.5);

  assert.ok(look.centimetresPerCountAt(AIM_DIAGNOSTIC_RANGE_METRES) < 1.7);
  assert.ok(look.centimetresPerCountAt(AIM_DIAGNOSTIC_RANGE_METRES) > 1.5);
});

test("optic FOV and ADS blend continuously scale mouse input", () => {
  const look = new LookSensitivityController();
  const hip = look.radiansPerCount;
  look.setOpticState(0.5, 60, 5.5);
  const halfAds = look.radiansPerCount;
  look.setOpticState(1, 60, 5.5);
  const defaultOptic = look.radiansPerCount;
  look.setOpticState(1, 60, 2.5);
  const narrowOptic = look.radiansPerCount;
  look.setOpticState(1, 60, 9);
  const wideOptic = look.radiansPerCount;

  assert.ok(defaultOptic < halfAds && halfAds < hip);
  assert.ok(narrowOptic < defaultOptic && defaultOptic < wideOptic);
  const expected =
    DEFAULT_MOUSE_SENSITIVITY * opticFovSensitivityRatio(60, 5.5) * DEFAULT_SCOPE_PRECISION_SCALE;
  assert.ok(Math.abs(defaultOptic - expected) < 1e-15);
});

test("mouse aim query overrides are bounded and invalid values use defaults", () => {
  assert.deepEqual(parseMouseAimConfig("?mousesens=0.002&scopesens=0.4"), {
    baseRadiansPerCount: 0.002,
    scopePrecisionScale: 0.4,
  });
  assert.deepEqual(parseMouseAimConfig("?mousesens=nope&scopesens=Infinity"), {
    baseRadiansPerCount: DEFAULT_MOUSE_SENSITIVITY,
    scopePrecisionScale: DEFAULT_SCOPE_PRECISION_SCALE,
  });
  assert.deepEqual(parseMouseAimConfig("?mousesens=1&scopesens=0"), {
    baseRadiansPerCount: 0.01,
    scopePrecisionScale: 0.01,
  });

  const invalid = new LookSensitivityController({
    baseRadiansPerCount: Number.NaN,
    scopePrecisionScale: Number.POSITIVE_INFINITY,
  });
  assert.equal(invalid.baseRadiansPerCount, DEFAULT_MOUSE_SENSITIVITY);
  assert.equal(invalid.scopePrecisionScale, DEFAULT_SCOPE_PRECISION_SCALE);
});
