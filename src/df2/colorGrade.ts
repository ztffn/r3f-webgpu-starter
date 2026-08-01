// The global colour grade — DF2's own weather mechanism, as one shared TSL term.
//
// The colormap is PRE-SHADED, so time of day and weather cannot be lighting here: the
// original graded the finished picture instead, with `filter`, `gamma` and `saturation`
// scalars carried per map in the .trn manifest. Terrain, the relief march and the blade
// layer all sample that same colormap, so all three must apply the identical grade.

import { float, uniform, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

export interface ColorGradeSettings {
  /** RGB tint, 0-255 each, 128 neutral. Straight from the .trn manifest. */
  filter: [number, number, number];
  /** Contrast/brightness curve, 128 neutral. */
  gamma: number;
  /** Colour intensity, 128 neutral. */
  saturation: number;
}

export interface ColorGrade {
  /** Live, so a preset can be swapped without rebuilding three materials. */
  uniforms: {
    filter: NodeArg;
    gammaExponent: NodeArg;
    saturation: NodeArg;
  };
  /**
   * Grade a linear RGB node.
   *
   * APPLY BEFORE FOG, always. Fog colour is part of the preset and already carries the
   * hour; grading it a second time would push the horizon away from the sky it is
   * supposed to meet, which is the seam that makes a sky swap look wrong.
   */
  apply: (rgb: NodeArg) => NodeArg;
  set: (settings: ColorGradeSettings) => void;
}

/**
 * The exponent form of `.trn` gamma.
 *
 * A GUESS, and flagged as one: 128 has to be neutral and larger has to brighten, which
 * `128 / value` satisfies, but the original's actual curve is unrecovered and every map
 * in the expansion pack ships the neutral 128 — so no extracted data can currently
 * distinguish this from any other monotonic mapping through the same point.
 */
const gammaExponentOf = (gamma: number): number => 128 / Math.max(1, gamma);

export function createColorGrade(settings: ColorGradeSettings): ColorGrade {
  const uFilter = uniform(
    vec3(settings.filter[0] / 128, settings.filter[1] / 128, settings.filter[2] / 128)
  );
  const uGamma = uniform(gammaExponentOf(settings.gamma));
  const uSaturation = uniform(settings.saturation / 128);

  // Saturation, then tint, then gamma. The original's order is unknown; this one is
  // chosen so the tint lands on colour that still has its full range, and the curve
  // lands last where it behaves like an exposure control.
  const apply = (rgb: NodeArg): NodeArg => {
    const luma = rgb.dot(vec3(0.2126, 0.7152, 0.0722));
    const saturated = uSaturation.mix(vec3(luma, luma, luma), rgb);
    return saturated.mul(uFilter).max(float(0)).pow(uGamma);
  };

  return {
    uniforms: { filter: uFilter, gammaExponent: uGamma, saturation: uSaturation },
    apply,
    set: (next) => {
      uFilter.value.set(next.filter[0] / 128, next.filter[1] / 128, next.filter[2] / 128);
      uGamma.value = gammaExponentOf(next.gamma);
      uSaturation.value = next.saturation / 128;
    },
  };
}
