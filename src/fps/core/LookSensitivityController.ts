// Roughly 33 cm/360° at 800 DPI when raw pointer input is available.
export const DEFAULT_MOUSE_SENSITIVITY = 0.0006;
export const DEFAULT_SCOPE_PRECISION_SCALE = 0.25;
export const AIM_DIAGNOSTIC_RANGE_METRES = 1_300;

export interface MouseAimConfig {
  readonly baseRadiansPerCount: number;
  readonly scopePrecisionScale: number;
}

const clampFinite = (value: number, fallback: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function parseMouseAimConfig(search: string): MouseAimConfig {
  const query = new URLSearchParams(search);
  const base = Number(query.get("mousesens"));
  const scope = Number(query.get("scopesens"));
  return {
    baseRadiansPerCount:
      query.has("mousesens")
        ? clampFinite(base, DEFAULT_MOUSE_SENSITIVITY, 0.00005, 0.01)
        : DEFAULT_MOUSE_SENSITIVITY,
    scopePrecisionScale:
      query.has("scopesens")
        ? clampFinite(scope, DEFAULT_SCOPE_PRECISION_SCALE, 0.01, 1)
        : DEFAULT_SCOPE_PRECISION_SCALE,
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
  private currentRadiansPerCount: number;

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
    this.currentRadiansPerCount = this.baseRadiansPerCount;
  }

  get radiansPerCount(): number {
    return this.currentRadiansPerCount;
  }

  setOpticState(adsBlend: number, mainFovDegrees: number, opticFovDegrees: number): void {
    const blend = clampFinite(adsBlend, 0, 0, 1);
    const scoped =
      this.baseRadiansPerCount *
      opticFovSensitivityRatio(mainFovDegrees, opticFovDegrees) *
      this.scopePrecisionScale;
    this.currentRadiansPerCount =
      this.baseRadiansPerCount + (scoped - this.baseRadiansPerCount) * blend;
  }

  reset(): void {
    this.currentRadiansPerCount = this.baseRadiansPerCount;
  }

  centimetresPerCountAt(rangeMetres: number): number {
    const safeRange = Math.max(0, Number.isFinite(rangeMetres) ? rangeMetres : 0);
    return Math.tan(Math.abs(this.currentRadiansPerCount)) * safeRange * 100;
  }
}
