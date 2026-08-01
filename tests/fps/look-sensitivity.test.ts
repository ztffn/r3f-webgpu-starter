import assert from "node:assert/strict";
import test from "node:test";
import {
  AIM_DIAGNOSTIC_RANGE_METRES,
  DEFAULT_MOUSE_SENSITIVITY,
  DEFAULT_SCAN_CURVE_BOOST,
  DEFAULT_SCOPE_PRECISION_SCALE,
  LookSensitivityController,
  opticFovSensitivityRatio,
  parseMouseAimConfig,
} from "../../src/fps/core/LookSensitivityController.ts";

test("scope sensitivity meets the 5 cm default-optic bound at 1300 m", () => {
  const look = new LookSensitivityController();
  look.setOpticState(1, 1, 60, 5.5);

  assert.ok(look.centimetresPerCountAt(AIM_DIAGNOSTIC_RANGE_METRES) < 1.7);
  assert.ok(look.centimetresPerCountAt(AIM_DIAGNOSTIC_RANGE_METRES) > 1.5);
});

test("optic FOV, ADS, and breath continuously scale mouse input", () => {
  const look = new LookSensitivityController();
  const hip = look.radiansPerCount;
  look.setOpticState(0.5, 0, 60, 5.5);
  const halfAds = look.radiansPerCount;
  look.setOpticState(1, 0, 60, 5.5);
  const scan = look.radiansPerCount;
  look.setOpticState(1, 1, 60, 5.5);
  const defaultOptic = look.radiansPerCount;
  look.setOpticState(1, 1, 60, 2.5);
  const narrowOptic = look.radiansPerCount;
  look.setOpticState(1, 1, 60, 9);
  const wideOptic = look.radiansPerCount;

  assert.ok(scan < halfAds && halfAds < hip);
  assert.ok(defaultOptic < scan);
  assert.ok(narrowOptic < defaultOptic && defaultOptic < wideOptic);
  const expected =
    DEFAULT_MOUSE_SENSITIVITY * opticFovSensitivityRatio(60, 5.5) * DEFAULT_SCOPE_PRECISION_SCALE;
  assert.ok(Math.abs(defaultOptic - expected) < 1e-15);
});

test("default optic supports scan speed and held-breath precision at 1300 m", () => {
  const look = new LookSensitivityController();
  look.setOpticState(1, 0, 60, 5.5);
  const scanCentimetres = look.centimetresPerCountAt(AIM_DIAGNOSTIC_RANGE_METRES);
  look.setOpticState(1, 1, 60, 5.5);
  const precisionCentimetres = look.centimetresPerCountAt(AIM_DIAGNOSTIC_RANGE_METRES);

  assert.ok(scanCentimetres > 6 && scanCentimetres < 7);
  assert.ok(precisionCentimetres > 1.5 && precisionCentimetres < 1.7);
});

test("mouse aim query overrides are bounded and invalid values use defaults", () => {
  assert.deepEqual(parseMouseAimConfig("?mousesens=0.002&scopesens=0.4"), {
    baseRadiansPerCount: 0.002,
    scopePrecisionScale: 0.4,
    scanCurveBoost: DEFAULT_SCAN_CURVE_BOOST,
  });
  assert.deepEqual(parseMouseAimConfig("?mousesens=nope&scopesens=Infinity"), {
    baseRadiansPerCount: DEFAULT_MOUSE_SENSITIVITY,
    scopePrecisionScale: DEFAULT_SCOPE_PRECISION_SCALE,
    scanCurveBoost: DEFAULT_SCAN_CURVE_BOOST,
  });
  assert.deepEqual(parseMouseAimConfig("?mousesens=1&scopesens=0"), {
    baseRadiansPerCount: 0.01,
    scopePrecisionScale: 0.01,
    scanCurveBoost: DEFAULT_SCAN_CURVE_BOOST,
  });

  const invalid = new LookSensitivityController({
    baseRadiansPerCount: Number.NaN,
    scopePrecisionScale: Number.POSITIVE_INFINITY,
    scanCurveBoost: Number.NaN,
  });
  assert.equal(invalid.baseRadiansPerCount, DEFAULT_MOUSE_SENSITIVITY);
  assert.equal(invalid.scopePrecisionScale, DEFAULT_SCOPE_PRECISION_SCALE);
  assert.equal(invalid.scanCurveBoost, DEFAULT_SCAN_CURVE_BOOST);
});

test("bounded response curve preserves micro aim and accelerates scans", () => {
  const look = new LookSensitivityController();
  look.setOpticState(1, 0, 60, 5.5);
  const linear = look.radiansPerCount;
  assert.equal(look.radiansPerCountForMovement(1, 0), linear);
  assert.equal(
    look.radiansPerCountForMovement(12, 0),
    linear * (1 + DEFAULT_SCAN_CURVE_BOOST)
  );

  look.setOpticState(1, 1, 60, 5.5);
  assert.equal(look.radiansPerCountForMovement(12, 0), look.radiansPerCount);
});
