// Roughly 33 cm/360° at 800 DPI when raw pointer input is available.
export const DEFAULT_MOUSE_SENSITIVITY = 0.0006;
export const DEFAULT_SCOPE_PRECISION_SCALE = 0.25;
export const DEFAULT_SCAN_CURVE_BOOST = 1.25;
export const AIM_DIAGNOSTIC_RANGE_METRES = 1_300;

export interface MouseAimConfig {
  readonly baseRadiansPerCount: number;
  readonly scopePrecisionScale: number;
  readonly scanCurveBoost: number;
}

const clampFinite = (value: number, fallback: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function parseMouseAimConfig(search: string): MouseAimConfig {
  const query = new URLSearchParams(search);
  const base = Number(query.get("mousesens"));
  const scope = Number(query.get("scopesens"));
  const curve = Number(query.get("aimcurve"));
  return {
    baseRadiansPerCount:
      query.has("mousesens")
        ? clampFinite(base, DEFAULT_MOUSE_SENSITIVITY, 0.00005, 0.01)
        : DEFAULT_MOUSE_SENSITIVITY,
    scopePrecisionScale:
      query.has("scopesens")
        ? clampFinite(scope, DEFAULT_SCOPE_PRECISION_SCALE, 0.01, 1)
        : DEFAULT_SCOPE_PRECISION_SCALE,
    scanCurveBoost:
      query.has("aimcurve")
        ? clampFinite(curve, DEFAULT_SCAN_CURVE_BOOST, 0, 3)
        : DEFAULT_SCAN_CURVE_BOOST,
  };
}

export const MOUSE_AIM_CONFIG = parseMouseAimConfig(
  typeof window === "undefined" ? "" : window.location.search
);

const halfFovTangent = (degrees: number): number => {
  const safeDegrees = clampFinite(degrees, 60, 0.1, 179);
  return Math.tan((safeDegrees * Math.PI) / 360);
};

export function opticFovSensitivityRatio(mainFovDegrees: number, opticFovDegrees: number): number {
  return halfFovTangent(opticFovDegrees) / halfFovTangent(mainFovDegrees);
}

/** Mutable, allocation-free mouse scaling shared by the camera and optic adapters. */
export class LookSensitivityController {
  readonly baseRadiansPerCount: number;
  readonly scopePrecisionScale: number;
  readonly scanCurveBoost: number;
  private currentRadiansPerCount: number;
  private currentBreathStabilization = 0;

  constructor(config: MouseAimConfig = MOUSE_AIM_CONFIG) {
    this.baseRadiansPerCount = clampFinite(
      config.baseRadiansPerCount,
      DEFAULT_MOUSE_SENSITIVITY,
      0.00005,
      0.01
    );
    this.scopePrecisionScale = clampFinite(
      config.scopePrecisionScale,
      DEFAULT_SCOPE_PRECISION_SCALE,
      0.01,
      1
    );
    this.scanCurveBoost = clampFinite(
      config.scanCurveBoost,
      DEFAULT_SCAN_CURVE_BOOST,
      0,
      3
    );
    this.currentRadiansPerCount = this.baseRadiansPerCount;
  }

  get radiansPerCount(): number {
    return this.currentRadiansPerCount;
  }

  setOpticState(
    adsBlend: number,
    breathStabilization: number,
    mainFovDegrees: number,
    opticFovDegrees: number
  ): void {
    const blend = clampFinite(adsBlend, 0, 0, 1);
    const breath = clampFinite(breathStabilization, 0, 0, 1);
    this.currentBreathStabilization = breath;
    const scan =
      this.baseRadiansPerCount *
      opticFovSensitivityRatio(mainFovDegrees, opticFovDegrees);
    const precision = scan * this.scopePrecisionScale;
    const scoped = scan + (precision - scan) * breath;
    this.currentRadiansPerCount =
      this.baseRadiansPerCount + (scoped - this.baseRadiansPerCount) * blend;
  }

  reset(): void {
    this.currentRadiansPerCount = this.baseRadiansPerCount;
    this.currentBreathStabilization = 0;
  }

  radiansPerCountForMovement(movementX: number, movementY: number): number {
    const magnitude = Math.hypot(movementX, movementY);
    const curvePosition = clampFinite((magnitude - 1) / 11, 0, 0, 1);
    const smoothCurve = curvePosition * curvePosition * (3 - 2 * curvePosition);
    const availableBoost = this.scanCurveBoost * (1 - this.currentBreathStabilization);
    return this.currentRadiansPerCount * (1 + availableBoost * smoothCurve);
  }

  centimetresPerCountAt(rangeMetres: number): number {
    const safeRange = Math.max(0, Number.isFinite(rangeMetres) ? rangeMetres : 0);
    return Math.tan(Math.abs(this.currentRadiansPerCount)) * safeRange * 100;
  }
}
