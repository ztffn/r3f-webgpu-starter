// Weather and time-of-day presets, in DF2's own parameterisation.
//
// The original shipped these per map in the .trn manifest — a sky bitmap and palette,
// plus `filter`, `gamma` and `saturation` scalars grading a pre-shaded colormap. Every
// map in this expansion pack ships the neutral daylight values, so the mechanism is
// confirmed but no authored example survives; these presets are ours, in that shape.

import type { ColorGradeSettings } from "./colorGrade";
import { FOG_COLOR, FOG_FAR, FOG_NEAR, SKY_COLOR } from "./config";

export interface WeatherPreset extends ColorGradeSettings {
  id: string;
  /**
   * Cubemap folder under /assets/sky, or null for the flat background colour.
   *
   * A CUBEMAP IS A MODERNISATION and worth recording as one: DF2 wrapped a bitmap
   * around the horizon with a `sky_height` and a horizon flag, which is cylindrical,
   * not a cube. The substitution is forced rather than chosen — every .trn names
   * `clouds01`/`skygrd01`, and neither is in the extracted expansion pack, because they
   * live in the retail base archive this project never commits. The only place the
   * difference can show is straight up, which a prone shooter rarely looks at.
   */
  sky: string | null;
  /**
   * Fog colour, and it is NOT free to choose: terrain fades into this, so it has to
   * match the sky's horizon or the ground ends in a band of the wrong colour. This is
   * the single detail that decides whether a sky swap reads as an hour of the day or as
   * a mistake.
   */
  fogColor: string;
  fogNear: number;
  fogFar: number;
  /** Flat background, used only when `sky` is null, and the hemisphere light's colour. */
  skyColor: string;
}

/** Neutral: what shipped before presets existed, and what every real .trn carries. */
const DAY: WeatherPreset = {
  id: "day",
  sky: null,
  skyColor: SKY_COLOR,
  fogColor: FOG_COLOR,
  fogNear: FOG_NEAR,
  fogFar: FOG_FAR,
  filter: [128, 128, 128],
  gamma: 128,
  saturation: 128,
};

/**
 * MEASURED, not authored by eye — tools regenerate these from the skyboxes themselves
 * (the generator lives in the session scratchpad; the method is what matters and is
 * recorded here).
 *
 * Three rules produce every number below, and each exists because guessing broke it:
 *
 *   1. GROUND LUMINANCE FOLLOWS SKY LUMINANCE, per channel and in full. The first hand-
 *      written dusk preset was a warm nudge and left full-daylight ground under a sky at
 *      a third of its brightness, which reads as a bug rather than as evening. On a
 *      pre-shaded colormap the grade is the only thing carrying the hour.
 *   2. HUE FOLLOWS ONLY PARTLY, at 60%, and RELATIVE TO THE CLEAR SKY rather than to
 *      grey. Ground under a red sky is reddish, not red, because its own albedo still
 *      dominates; and the colormap was baked under a blue daylight sky, so grading
 *      toward the blue of a clear sky would count that blue twice. Relative, `clear`
 *      comes out exactly neutral — which is the only value it can correctly have, and
 *      the check that the method is right.
 *   3. NIGHT HAS A FLOOR, and that one is a deliberate lie. Sky matching is correct
 *      while there is a sun; below about a fifth of daylight it stops being a rendering
 *      question and becomes a playability one, because a moonless night is genuinely too
 *      dark to play. The floor holds at 0.17 and the hue pushes blue, which is how film
 *      has signalled night since day-for-night shooting.
 *
 * The Land and Ocean variants of the pack are deliberately absent: they differ only in
 * the lower hemisphere, which terrain covers completely, and their baked ground fights
 * the real one at the horizon.
 */
export const WEATHER_PRESETS: Record<string, WeatherPreset> = {
  day: DAY,
  classic: {
    id: "classic",
    sky: "classic",
    skyColor: "#907dde",
    fogColor: "#a0a1e7",
    fogNear: 264,
    fogFar: 2200,
    filter: [188, 134, 162],
    gamma: 128,
    saturation: 122,
  },
  clear: {
    id: "clear",
    sky: "clear",
    skyColor: "#557fa4",
    fogColor: "#a3b6bf",
    fogNear: 264,
    fogFar: 2200,
    filter: [128, 128, 128],
    gamma: 128,
    saturation: 128,
  },
  overcast: {
    id: "overcast",
    sky: "overcast",
    skyColor: "#5b595f",
    fogColor: "#6a6565",
    fogNear: 195,
    fogFar: 1628,
    filter: [120, 91, 82],
    gamma: 128,
    saturation: 72,
  },
  apocalypse: {
    id: "apocalypse",
    sky: "apocalypse",
    skyColor: "#c23e20",
    fogColor: "#b82503",
    fogNear: 193,
    fogFar: 1606,
    filter: [213, 75, 52],
    gamma: 128,
    saturation: 174,
  },
  dusk: {
    id: "dusk",
    sky: "dusk",
    skyColor: "#52514a",
    fogColor: "#8c8c8c",
    fogNear: 177,
    fogFar: 1474,
    filter: [109, 83, 69],
    gamma: 128,
    saturation: 76,
  },
  moody: {
    id: "moody",
    sky: "moody",
    skyColor: "#373237",
    fogColor: "#5a575c",
    fogNear: 111,
    fogFar: 924,
    filter: [71, 51, 47],
    gamma: 128,
    saturation: 77,
  },
  dawn: {
    id: "dawn",
    sky: "dawn",
    skyColor: "#5c2800",
    fogColor: "#722400",
    fogNear: 106,
    fogFar: 880,
    filter: [104, 45, 20],
    gamma: 128,
    saturation: 190,
  },
  sinister: {
    id: "sinister",
    sky: "sinister",
    skyColor: "#211f35",
    fogColor: "#211f35",
    fogNear: 92,
    fogFar: 770,
    filter: [43, 32, 38],
    gamma: 128,
    saturation: 119,
  },
  techno: {
    id: "techno",
    sky: "techno",
    skyColor: "#181d20",
    fogColor: "#191d20",
    fogNear: 92,
    fogFar: 770,
    filter: [33, 29, 27],
    gamma: 128,
    saturation: 98,
  },
  netherworld: {
    id: "netherworld",
    sky: "netherworld",
    skyColor: "#0d0724",
    fogColor: "#0d0724",
    fogNear: 92,
    fogFar: 770,
    filter: [18, 20, 27],
    gamma: 128,
    saturation: 82,
  },
  night: {
    id: "night",
    sky: "night",
    skyColor: "#080402",
    fogColor: "#080402",
    fogNear: 92,
    fogFar: 770,
    filter: [18, 20, 27],
    gamma: 128,
    saturation: 82,
  },
  space: {
    id: "space",
    sky: "space",
    skyColor: "#070104",
    fogColor: "#080105",
    fogNear: 92,
    fogFar: 770,
    filter: [18, 20, 27],
    gamma: 128,
    saturation: 82,
  },
};

/** `?weather=` — falls back to the neutral preset on anything unrecognised. */
export function readWeather(search: string): WeatherPreset {
  const requested = new URLSearchParams(search).get("weather");
  return (requested && WEATHER_PRESETS[requested]) || DAY;
}
