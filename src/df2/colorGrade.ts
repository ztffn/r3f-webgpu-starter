// The global colour grade — DF2's own weather mechanism, as one shared TSL term.
//
// The colormap is PRE-SHADED, so time of day and weather cannot be lighting here: the
// original graded the finished picture instead, with `filter`, `gamma` and `saturation`
// scalars carried per map in the .trn manifest. Terrain, the relief march and the blade
// layer all sample that same colormap, so all three must apply the identical grade.

import { float, uniform, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

/**
 * Rec. 709 luminance of a colour node.
 *
 * EXPORTED because the fog's haze-drain needs the identical value, and the alpha trap
 * below is the kind that has to be fixed once. `.rgb` first: callers pass a vec4 straight
 * from `texture()`, and dotting that against a vec3 promotes the constant with w = 1, so
 * the "luminance" comes out about 1.0 too high — which painted the whole terrain beige.
 */
export const luminance = (rgb: NodeArg): NodeArg =>
  rgb.rgb.dot(vec3(0.2126, 0.7152, 0.0722));

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
    /**
     * How far the preset's grade is applied, 0 raw to 1 full. Above 1 exaggerates.
     *
     * One dial across all three of `filter`, `gamma` and `saturation`, because the
     * question being asked of it is "how much does this weather recolour the ground",
     * not "which of the three scalars is too strong" — and it stays honest to the .trn
     * model, where the three arrive together as one authored look.
     */
    strength: NodeArg;
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
  // Not part of the .trn model and deliberately not written by `set` — it is an
  // authoring dial that survives preset switches, so a look can be judged at one
  // strength across every sky rather than being reset by each button press.
  const uStrength = uniform(1);

  // Saturation, then tint, then gamma. The original's order is unknown; this one is
  // chosen so the tint lands on colour that still has its full range, and the curve
  // lands last where it behaves like an exposure control.
  const apply = (rgb: NodeArg): NodeArg => {
    // The alpha trap this used to fall into is documented on `luminance` above. It hid
    // for as long as it did because at saturation 128 the mix weight is exactly 1, which
    // discards the luminance entirely — and every extracted map ships the neutral 128.
    // The first preset with a non-neutral saturation made it visible at once.
    const c = rgb.rgb;
    const luma = luminance(c);
    const saturated = uSaturation.mix(vec3(luma, luma, luma), c);
    const graded = saturated.mul(uFilter).max(float(0)).pow(uGamma);
    // Blended against the UNGRADED colour, so 0 is the raw pre-shaded colormap exactly
    // as the map author baked it. Interpolant is the receiver: `t.mix(a, b)` is
    // `mix(a, b, t)` — the reordering catalogued in docs/08 §11.
    return uStrength.mix(c, graded);
  };

  return {
    uniforms: {
      filter: uFilter,
      gammaExponent: uGamma,
      saturation: uSaturation,
      strength: uStrength,
    },
    apply,
    set: (next) => {
      uFilter.value.set(next.filter[0] / 128, next.filter[1] / 128, next.filter[2] / 128);
      uGamma.value = gammaExponentOf(next.gamma);
      uSaturation.value = next.saturation / 128;
    },
  };
}
