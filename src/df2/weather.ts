// Weather and time-of-day presets, in DF2's own parameterisation.
//
// The original shipped these per map in the .trn manifest — a sky bitmap and palette,
// plus `filter`, `gamma` and `saturation` scalars grading a pre-shaded colormap. Every
// map in this expansion pack ships the neutral daylight values, so the mechanism is
// confirmed but no authored example survives; these presets are ours, in that shape.

import type { ColorGradeSettings } from "./colorGrade";
// EXPLICIT .ts, because this module is now loaded by Node as well as by Vite: the
// authoritative server picks a room's preset from it and the session test pins the
// wire order. Node's ESM resolver does not guess extensions, so an extensionless
// specifier here fails at import time on the server while working in the browser.
import { FOG_COLOR, FOG_FAR, FOG_NEAR, SKY_COLOR } from "./config.ts";

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
  /**
   * Ground fog: the world height where it is thickest, and how thick it is per metre.
   *
   * ABSOLUTE height, so the layer settles into hollows and leaves ridges standing out of
   * it. Green Mile's terrain runs about 5-174 m, so a level near 100 puts fog in this
   * map's valleys; a preset for another map wants its own.
   *
   * Density 0 means no ground layer, which is most presets — this is weather, not a
   * permanent feature.
   */
  groundFogTop: number;
  /**
   * The bottom of the slab. Below the terrain's own minimum — 0 on this map — it is
   * ordinary ground fog. Raised above the valley floor, the layer lifts off the ground
   * into a band lying against the hillsides: clear underneath, clear above, and blind at
   * one altitude, which takes a ridge out of use as a firing position while leaving the
   * valley below it open.
   */
  groundFogBase: number;
  groundFogDensity: number;
  /** Fraction of the precipitation pool drawn, 0-1. 0 is dry. */
  rain: number;
  /** 0 rain, 1 snow. Blended, so a value between the two is sleet. */
  snow: number;
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
  groundFogTop: 0,
  groundFogBase: 0,
  groundFogDensity: 0,
  rain: 0,
  snow: 0,
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
    groundFogTop: 0,
    groundFogBase: 0,
    groundFogDensity: 0.0,
    rain: 0,
    snow: 0,
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
    groundFogTop: 0,
    groundFogBase: 0,
    groundFogDensity: 0.0,
    rain: 0,
    snow: 0,
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
    groundFogTop: 128,
    groundFogBase: 0,
    groundFogDensity: 0.0022,
    rain: 0.25,
    snow: 0,
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
    groundFogTop: 128,
    groundFogBase: 0,
    groundFogDensity: 0.0013,
    rain: 0.3,
    snow: 0,
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
    groundFogTop: 126,
    groundFogBase: 0,
    groundFogDensity: 0.0018,
    rain: 0.12,
    snow: 0,
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
    groundFogTop: 132,
    groundFogBase: 0,
    groundFogDensity: 0.0044,
    rain: 0.55,
    snow: 0,
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
    groundFogTop: 130,
    groundFogBase: 0,
    groundFogDensity: 0.0035,
    rain: 0,
    snow: 0,
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
    groundFogTop: 136,
    groundFogBase: 0,
    groundFogDensity: 0.0062,
    rain: 0.8,
    snow: 0,
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
    groundFogTop: 0,
    groundFogBase: 0,
    groundFogDensity: 0.0,
    rain: 0.2,
    snow: 0,
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
    groundFogTop: 140,
    groundFogBase: 0,
    groundFogDensity: 0.0066,
    rain: 0.4,
    snow: 1,
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
    groundFogTop: 128,
    groundFogBase: 0,
    groundFogDensity: 0.0026,
    rain: 0,
    snow: 0,
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
    groundFogTop: 0,
    groundFogBase: 0,
    groundFogDensity: 0.0,
    rain: 0,
    snow: 0,
  },

  // --- Kenney Skyboxes 1.0, CC0 (tools/sky-convert) --------------------------
  //
  // A SECOND PACK ON PURPOSE, and the contrast is the point. These are smooth painted
  // gradients with a soft horizon and a graded lower hemisphere; the retro pack is
  // photographic with a hard painted floor. The haze samples the sky now, so the two
  // stress it differently — this pack is the case where "Haze horizon lift" can sit near
  // zero, and the retro pack is the case that proved it has to exist at all.
  //
  // Converted from 4096x2048 panoramas rather than shipped as faces. Every colour below
  // is measured from the source by that tool, not picked by eye.
  kday: {
    id: "kday",
    sky: "kenney-day",
    skyColor: "#a4c1f1",
    fogColor: "#aec3f2",
    fogNear: 264,
    fogFar: 2200,
    filter: [128, 128, 128],
    gamma: 128,
    saturation: 128,
    groundFogTop: 0,
    groundFogBase: 0,
    groundFogDensity: 0.0,
    rain: 0,
    snow: 0,
  },
  kmorning: {
    id: "kmorning",
    sky: "kenney-morning",
    skyColor: "#fce5cf",
    fogColor: "#f9dcc1",
    fogNear: 232,
    fogFar: 1936,
    filter: [156, 132, 108],
    gamma: 128,
    saturation: 118,
    groundFogTop: 96,
    groundFogBase: 0,
    groundFogDensity: 0.0016,
    rain: 0,
    snow: 0,
  },
  knight: {
    id: "knight",
    sky: "kenney-night",
    skyColor: "#2c3a6b",
    fogColor: "#2d3a67",
    fogNear: 110,
    fogFar: 920,
    filter: [46, 56, 92],
    gamma: 128,
    saturation: 88,
    groundFogTop: 128,
    groundFogBase: 0,
    groundFogDensity: 0.0022,
    rain: 0,
    snow: 0,
  },
  kalien: {
    id: "kalien",
    sky: "kenney-alien",
    skyColor: "#d7b8f0",
    fogColor: "#d9c5e8",
    fogNear: 220,
    fogFar: 1830,
    filter: [146, 118, 162],
    gamma: 128,
    saturation: 142,
    groundFogTop: 0,
    groundFogBase: 0,
    groundFogDensity: 0.0,
    rain: 0,
    snow: 0,
  },
  kspace: {
    id: "kspace",
    sky: "kenney-space",
    skyColor: "#1d2956",
    fogColor: "#242e61",
    fogNear: 92,
    fogFar: 770,
    filter: [36, 44, 82],
    gamma: 128,
    saturation: 80,
    groundFogTop: 0,
    groundFogBase: 0,
    groundFogDensity: 0.0,
    rain: 0,
    snow: 0,
  },
};

/** `?weather=` — falls back to the neutral preset on anything unrecognised. */
export function readWeather(search: string): WeatherPreset {
  const requested = new URLSearchParams(search).get("weather");
  return (requested && WEATHER_PRESETS[requested]) || DAY;
}

/**
 * WIRE ORDER for the authoritative preset, and it is APPEND-ONLY.
 *
 * The server replicates its room's weather as an index into this list rather than
 * as a string, so reordering or removing an entry above silently repoints every
 * connected client at a different sky — the kind of break that shows up as "the
 * other player sees different fog" rather than as an error. New presets go on the
 * end, and `tests/motor/session.test.ts` pins the order so a reorder fails there
 * instead of in a match. Index 0 is the neutral `day`, which is also the fallback.
 *
 * Derived from the table rather than written out twice: two lists that must agree
 * is agreement by hand, and this file already says why that is the thing to avoid.
 */
export const WEATHER_PRESET_IDS: readonly string[] = Object.keys(WEATHER_PRESETS);

/** Unknown ids resolve to `day` — the server logs its own miss, see game-server. */
export function weatherPresetIndex(id: string): number {
  const at = WEATHER_PRESET_IDS.indexOf(id);
  return at < 0 ? 0 : at;
}

/**
 * The preset a wire index names.
 *
 * Falls back to `day` on an index this build has never heard of, which is the
 * real case rather than a defensive one: a server on a newer build can name a
 * preset that shipped after the client did, and the honest answer to that is
 * neutral daylight rather than a crash or a random sky.
 */
export function weatherPresetAt(index: number): WeatherPreset {
  const id = WEATHER_PRESET_IDS[index];
  return (id !== undefined && WEATHER_PRESETS[id]) || DAY;
}
