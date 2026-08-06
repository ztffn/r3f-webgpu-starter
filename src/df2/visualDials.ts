// The live visual dials, as one table: wire contract and accessors together.
// (The count is pinned by tests/motor/session.test.ts, not by this comment.)
//
// Extracted from WeatherDebug so the debug panel and the authoritative server can
// agree on what a dial IS — its identity on the wire, its legal range, and how to
// read and write it. Two tables keyed by hand is the drift this file exists to
// prevent: the server clamps to the same range the panel shows.
//
// Node-safe at runtime, and it has to stay that way: the authoritative server
// imports `clampVisualDial` from here. Every type import below is `import type` so
// nothing pulls Three into Node — a value import from any of them breaks the server,
// and only the Node tests will tell you.

import type { BladeUniforms } from "./BladeMaterial";
import type { createColorGrade } from "./colorGrade";
import type { createFog } from "./fog";
import type { createPrecipitation } from "./Precipitation";
import type { TerrainDetailUniforms } from "./TerrainMaterial";

/**
 * What a dial needs to read and write. `SceneHandles` satisfies this structurally
 * — it is not declared as implementing it, because the panel's handles legitimately
 * carry more than the dials touch.
 */
export interface VisualDialTargets {
  /** Shadowed, because `setIntensity` moves a draw count that is not readable back. */
  readonly rain: number;
  readonly grade: ReturnType<typeof createColorGrade>;
  readonly fog: ReturnType<typeof createFog>;
  readonly precipitation: ReturnType<typeof createPrecipitation>;
  readonly blades: BladeUniforms | null;
  /** Null when the map ships no detail_color assets (loadTerrain.ts). */
  readonly terrainDetail: TerrainDetailUniforms | null;
}

export type VisualDialGroup = "atmosphere" | "precipitation" | "blades" | "terrain";

export interface VisualDial {
  readonly label: string;
  readonly group: VisualDialGroup;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly get: (t: VisualDialTargets) => number;
  readonly set: (t: VisualDialTargets, v: number) => void;
  readonly hint?: string;
}

/**
 * WIRE ORDER, and it is APPEND-ONLY for the same reason `WEATHER_PRESET_IDS` is:
 * a dial's index in this array IS its identity on the wire, so inserting or
 * removing an entry silently repoints an admin's fog setting at somebody's blade
 * twist. New dials go on the END. `tests/motor/session.test.ts` pins the order and
 * the count so a reorder fails there rather than in a room.
 *
 * Grouped for the panel's benefit, but the groups are contiguous only by
 * convention — nothing reads them positionally.
 */
export const VISUAL_DIALS: readonly VisualDial[] = [
  // --- atmosphere ------------------------------------------------------------
  {
    label: "Preset grade strength",
    group: "atmosphere",
    min: 0,
    max: 2,
    step: 0.01,
    get: (t) => Number(t.grade.uniforms.strength.value),
    set: (t, v) => (t.grade.uniforms.strength.value = v),
    hint: "how far the sky's own tint, gamma and saturation recolour the ground. 0 is the raw colormap",
  },
  {
    label: "Sky-tinted haze",
    group: "atmosphere",
    min: 0,
    max: 1,
    step: 0.01,
    get: (t) => Number(t.fog.uniforms.skyAmount.value),
    set: (t, v) => (t.fog.uniforms.skyAmount.value = v),
    hint: "0 fades distance to the flat fog colour, 1 to the sky behind it. This is the A/B",
  },
  {
    label: "Haze softness",
    group: "atmosphere",
    min: 0,
    max: 1,
    step: 0.01,
    get: (t) => Number(t.fog.uniforms.skyBlur.value),
    set: (t, v) => (t.fog.uniforms.skyBlur.value = v),
    hint: "how much sky detail the haze keeps. Sharp stamps clouds onto distant ground",
  },
  {
    label: "Haze drains colour",
    group: "atmosphere",
    min: 0,
    max: 1,
    step: 0.01,
    get: (t) => Number(t.fog.uniforms.hazeDrain.value),
    set: (t, v) => (t.fog.uniforms.hazeDrain.value = v),
    hint: "0 cross-fades straight to the sky. Higher goes grey FIRST, sky-coloured later",
  },
  {
    label: "Haze horizon lift",
    group: "atmosphere",
    min: 0,
    max: 0.4,
    step: 0.01,
    get: (t) => Number(t.fog.uniforms.hazeLift.value),
    set: (t, v) => (t.fog.uniforms.hazeLift.value = v),
    hint: "keeps the haze off the skybox's baked ground. Too low turns the far field black",
  },
  {
    label: "Fog near",
    group: "atmosphere",
    // From 0, in metres. A near of a few metres is not a silly setting — it is how you
    // put the haze onto the near field to see what it does there, and the old floor of
    // 10 with a step of 10 made everything below that reachable only from a URL.
    min: 0,
    max: 1200,
    step: 1,
    get: (t) => Number(t.fog.uniforms.near.value),
    set: (t, v) => (t.fog.uniforms.near.value = v),
  },
  {
    label: "Fog far",
    group: "atmosphere",
    min: 100,
    max: 4000,
    step: 50,
    get: (t) => Number(t.fog.uniforms.far.value),
    set: (t, v) => (t.fog.uniforms.far.value = v),
  },
  {
    label: "Fog layer top",
    group: "atmosphere",
    min: 0,
    max: 260,
    step: 1,
    get: (t) => Number(t.fog.uniforms.groundTop.value),
    set: (t, v) => (t.fog.uniforms.groundTop.value = v),
    hint: "ABSOLUTE world height — Green Mile's terrain runs about 5 to 174 m",
  },
  {
    label: "Fog layer base",
    group: "atmosphere",
    min: 0,
    max: 260,
    step: 1,
    get: (t) => Number(t.fog.uniforms.groundBase.value),
    set: (t, v) => (t.fog.uniforms.groundBase.value = v),
    hint: "0 is ordinary ground fog. Raise it above the valley floor and the slab lifts off into a band — clear below, clear above, blind at one altitude",
  },
  {
    label: "Ground fog softness",
    group: "atmosphere",
    min: 1,
    max: 80,
    step: 1,
    get: (t) => Number(t.fog.uniforms.groundScale.value),
    set: (t, v) => (t.fog.uniforms.groundScale.value = v),
    hint: "metres for density to fall by 1/e above the level — small is a sharp lid",
  },
  {
    label: "Ground fog density",
    group: "atmosphere",
    min: 0,
    max: 0.02,
    step: 0.0002,
    get: (t) => Number(t.fog.uniforms.groundDensity.value),
    set: (t, v) => (t.fog.uniforms.groundDensity.value = v),
    // Range and step chosen from what the number does rather than from round figures:
    // optical depth reaches 1 — about 63% fogged — at 1/density metres, so 0.005 is
    // half-hidden at 140 m and the top of this dial is opaque within 50. Mild lives
    // between 0.001 and 0.004, which a 0.001 step could not reach.
    hint: "extinction per metre inside the layer; ~63% fogged at 1/density metres",
  },

  // --- precipitation ---------------------------------------------------------
  {
    label: "Rain",
    group: "precipitation",
    min: 0,
    max: 1,
    step: 0.01,
    get: (t) => t.rain,
    // Through setIntensity, never the uniform: the drawn instance range has to move with
    // it or the slider is capped at whatever the preset last set. THE ONE DIAL THAT MOVES
    // A DRAW COUNT — bounded by the pool allocated at load, so an admin can push a client
    // to its own ceiling and no further.
    set: (t, v) => t.precipitation.setIntensity(v),
    hint: "fraction of the drop pool drawn — independent of the preset's sky",
  },
  {
    label: "Snow",
    group: "precipitation",
    min: 0,
    max: 1,
    step: 0.01,
    get: (t) => Number(t.precipitation.uniforms.mode.value),
    set: (t, v) => (t.precipitation.uniforms.mode.value = v),
    hint: "0 rain, 1 snow — between them is sleet",
  },
  {
    label: "Drop opacity",
    group: "precipitation",
    min: 0,
    max: 0.3,
    step: 0.005,
    get: (t) => Number(t.precipitation.uniforms.opacity.value),
    set: (t, v) => (t.precipitation.uniforms.opacity.value = v),
  },
  {
    label: "Fall speed",
    group: "precipitation",
    min: 0.5,
    max: 25,
    step: 0.5,
    get: (t) => Number(t.precipitation.uniforms.fallSpeedRain.value),
    set: (t, v) => (t.precipitation.uniforms.fallSpeedRain.value = v),
  },

  // --- blades ----------------------------------------------------------------
  {
    label: "Brightness lift",
    group: "blades",
    min: 0.5,
    max: 3.5,
    step: 0.05,
    get: (t) => Number(t.blades?.lift.value ?? 0),
    set: (t, v) => t.blades && (t.blades.lift.value = v),
    hint: "the layer against the march — the dial that decides whether blades read",
  },
  {
    label: "Root/tip contrast",
    group: "blades",
    min: 0.1,
    max: 1,
    step: 0.01,
    get: (t) => Number(t.blades?.shadeBase.value ?? 0),
    set: (t, v) => t.blades && (t.blades.shadeBase.value = v),
    hint: "root brightness; the tip gets 2 minus this. NOT the same dial as lift",
  },
  {
    label: "Sun modulation",
    group: "blades",
    min: 0,
    max: 0.8,
    step: 0.01,
    get: (t) => Number(t.blades?.sun.value ?? 0),
    set: (t, v) => t.blades && (t.blades.sun.value = v),
    hint: "how much a blade facing the sun outshines one edge-on to it",
  },
  {
    label: "Field radius",
    group: "blades",
    min: 2,
    max: 40,
    step: 0.5,
    get: (t) => Number(t.blades?.radius.value ?? 0),
    set: (t, v) => t.blades && (t.blades.radius.value = v),
    hint: "metres. RAISING THIS LOWERS DENSITY — the count is fixed at load",
  },
  {
    label: "Thinning starts",
    group: "blades",
    min: 0,
    max: 20,
    step: 0.5,
    get: (t) => Number(t.blades?.thinStart.value ?? 0),
    set: (t, v) => t.blades && (t.blades.thinStart.value = v),
  },
  {
    label: "Player push",
    group: "blades",
    min: 0,
    max: 2,
    step: 0.05,
    get: (t) => Number(t.blades?.push.value ?? 0),
    set: (t, v) => t.blades && (t.blades.push.value = v),
    hint: "grass pushed aside is grass you can see through — keep it parting, not clearing",
  },
  {
    label: "Push radius",
    group: "blades",
    min: 0,
    max: 4,
    step: 0.1,
    get: (t) => Number(t.blades?.pushRadius.value ?? 0),
    set: (t, v) => t.blades && (t.blades.pushRadius.value = v),
  },
  {
    label: "Wind gain",
    group: "blades",
    min: 0,
    max: 0.3,
    step: 0.005,
    get: (t) => Number(t.blades?.windGain.value ?? 0),
    set: (t, v) => t.blades && (t.blades.windGain.value = v),
    hint: "lean per m/s. DIRECTION is not a dial — it is the vector that drifts bullets",
  },
  {
    label: "Resting bend",
    group: "blades",
    min: 0,
    max: 1.2,
    step: 0.01,
    get: (t) => Number(t.blades?.bend.value ?? 0),
    set: (t, v) => t.blades && (t.blades.bend.value = v),
  },
  {
    label: "Twist",
    group: "blades",
    min: 0,
    max: 6,
    step: 0.05,
    get: (t) => Number(t.blades?.twist.value ?? 0),
    set: (t, v) => t.blades && (t.blades.twist.value = v),
  },

  // --- terrain detail ----------------------------------------------------------
  // The close-range detail_color pass (08 §6.3). APPENDED — see the wire rule above.
  {
    label: "Detail gain",
    group: "terrain",
    min: 0.2,
    max: 3,
    step: 0.05,
    get: (t) => Number(t.terrainDetail?.gain.value ?? 0),
    set: (t, v) => t.terrainDetail && (t.terrainDetail.gain.value = v),
    hint: "brightness of the detail layer. 1 shows the tiles as authored, lit by the colormap's own shading",
  },
  {
    label: "Detail fade start",
    group: "terrain",
    min: 0,
    max: 400,
    step: 2,
    get: (t) => Number(t.terrainDetail?.near.value ?? 0),
    set: (t, v) => t.terrainDetail && (t.terrainDetail.near.value = v),
    hint: "metres of full-strength detail before the fade begins",
  },
  {
    label: "Detail fade end",
    group: "terrain",
    min: 10,
    max: 800,
    step: 5,
    get: (t) => Number(t.terrainDetail?.far.value ?? 0),
    set: (t, v) => t.terrainDetail && (t.terrainDetail.far.value = v),
    hint: "metres at which only the colormap remains — the original's railroad vanished at range too. Clamped in-shader to stay above the start",
  },
  {
    label: "Detail power",
    group: "terrain",
    min: 0,
    max: 1,
    step: 0.01,
    get: (t) => Number(t.terrainDetail?.power.value ?? 0),
    set: (t, v) => t.terrainDetail && (t.terrainDetail.power.value = v),
    hint: "master opacity of the layer — lowering it blends back toward the plain colormap, which is the lever if the tiles read too dark or saturated",
  },
];

/** Bounds by dial id, so the clamp below is one array lookup rather than a scan. */
const VISUAL_DIAL_RANGES: readonly { readonly min: number; readonly max: number }[] =
  VISUAL_DIALS.map((dial) => ({ min: dial.min, max: dial.max }));

/**
 * Clamps a dial write, or returns null if there is nothing legal to write.
 *
 * THE ONE COPY of this arithmetic, and it is handed to the authoritative server
 * rather than reimplemented there — the server clamps on the way in and
 * `applyVisualDials` clamps again on the way out, so two versions would diverge the
 * moment either gained a rule and the only symptom would be a slider settling
 * somewhere the room never asked for. `src/net` cannot import this module, so
 * `GameServerOptions.clampVisualDial` takes the function.
 *
 * Null for an unknown id (a newer peer naming a dial this build lacks) and for a
 * non-finite value, which is the case that matters: NaN assigned to a uniform does
 * not throw, it silently blanks or corrupts whatever that term feeds, and the
 * symptom appears somewhere else entirely.
 */
export function clampVisualDial(id: number, value: number): number | null {
  const range = VISUAL_DIAL_RANGES[id];
  if (range === undefined || !Number.isFinite(value)) return null;
  return Math.min(range.max, Math.max(range.min, value));
}

/** Applies a sparse override set on top of whatever the preset just wrote. */
export function applyVisualDials(
  targets: VisualDialTargets,
  overrides: ReadonlyMap<number, number>
): void {
  for (const [id, value] of overrides) {
    const clamped = clampVisualDial(id, value);
    if (clamped === null) continue;
    VISUAL_DIALS[id]!.set(targets, clamped);
  }
}
