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

export const WEATHER_PRESETS: Record<string, WeatherPreset> = {
  day: DAY,
  /**
   * Evening. Warm tint, slightly crushed, desaturated a touch because low sun flattens
   * colour before it flattens contrast.
   *
   * Fog pulled IN as well as recoloured. Haze reads thicker at dusk, and shortening the
   * far distance also hides the horizon where a 512-pixel cubemap face would otherwise
   * be stretched thinnest.
   */
  dusk: {
    id: "dusk",
    sky: "dusk",
    skyColor: "#4e4d45",
    // Sampled from the cubemap's own horizon band, not chosen. The pack's dusk sky is a
    // dark olive overcast with a pale strip where the sky meets its (black, terrain-
    // covered) lower hemisphere; distant ground has to fade into that strip or the
    // horizon shows as a line between two different evenings.
    fogColor: "#77757a",
    // Haze reads thicker at dusk, and pulling the far distance in also hides the band
    // where a 512-pixel cubemap face is stretched thinnest.
    fogNear: 150,
    fogFar: 1200,
    // FAR STRONGER THAN A TINT. The first pass at this preset was a warm nudge —
    // filter [150,118,104], gamma 118, saturation 112 — and it left full-daylight ground
    // under a sky at roughly a third of its luminance, which read as a bug rather than
    // as evening. The lesson generalises: on a pre-shaded colormap the grade is the ONLY
    // thing carrying the hour, so it has to do all the work a light would have done.
    filter: [88, 84, 74],
    gamma: 110,
    saturation: 95,
  },
};

/** `?weather=` — falls back to the neutral preset on anything unrecognised. */
export function readWeather(search: string): WeatherPreset {
  const requested = new URLSearchParams(search).get("weather");
  return (requested && WEATHER_PRESETS[requested]) || DAY;
}
