// The one call every scene material makes: grade the colour, then fog it, in that order.
//
// Existing as a module is the point. The ordering rule was written out per material, so
// terrain and the relief march each got it right and everything else got nothing at all —
// the blade layer turned fog off on reasoning that stopped being true, and a building
// added tomorrow would render at full contrast against hazed terrain with no line of code
// looking wrong. A material now asks for an Atmosphere and cannot compose it incorrectly.

import { positionWorld } from "three/tsl";
import type { ColorGrade } from "./colorGrade";
import type { Fog } from "./fog";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

export interface Atmosphere {
  /**
   * The fog alone — its LIVE uniforms, for debug views that read out the range they are
   * being fogged by. Deliberately the only half exposed: a scene material reaching past
   * `shade` is reaching for the ordering bug this module exists to prevent, and the grade
   * had no caller at all.
   */
  fog: Fog;
  /**
   * Shade a linear RGB node as scene geometry.
   *
   * GRADED BEFORE FOGGED, and that is not interchangeable. The fog colour is part of the
   * weather preset and already carries the hour, so grading it a second time pushes the
   * horizon away from the sky it is supposed to meet — the seam that makes a sky swap
   * read as a mistake rather than as an hour of the day.
   *
   * `worldPos` defaults to the fragment's own world position, which is right for
   * ordinary geometry. Pass it explicitly only when the shaded point is NOT where the
   * fragment was rasterised: the relief march has a hit position hundreds of metres from
   * its shell, and using the shell's depth washed near grass pale with fog it should
   * never have received.
   */
  shade: (rgb: NodeArg, worldPos?: NodeArg) => NodeArg;
}

export function createAtmosphere(grade: ColorGrade, fog: Fog): Atmosphere {
  return {
    fog,
    shade: (rgb, worldPos) => fog.apply(grade.apply(rgb), worldPos ?? positionWorld),
  };
}
