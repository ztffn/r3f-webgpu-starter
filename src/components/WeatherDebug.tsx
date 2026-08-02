// Live panel for weather, atmosphere, rain and the near-field blades, with ?debug=1.
//
// Sibling of GrassDebug and the same contract: every control writes straight to a
// uniform, so nothing re-renders and no material is rebuilt. That is not a nicety here —
// rebuilding discards the terrain geometry cache and stalls for about a second, which
// makes exactly the A/B comparison these dials exist for impossible.

import { useEffect, useState } from "react";
import type { SceneHandles } from "../df2/DF2Scene";
import { WEATHER_PRESETS } from "../df2/weather";

export interface WeatherDebugProps {
  scene: SceneHandles | null;
}

interface Dial {
  label: string;
  min: number;
  max: number;
  step: number;
  get: (s: SceneHandles) => number;
  set: (s: SceneHandles, v: number) => void;
  hint?: string;
}

const ATMOSPHERE: Dial[] = [
  {
    label: "Fog near",
    min: 10,
    max: 1200,
    step: 10,
    get: (s) => Number(s.fog.uniforms.near.value),
    set: (s, v) => (s.fog.uniforms.near.value = v),
  },
  {
    label: "Fog far",
    min: 100,
    max: 4000,
    step: 50,
    get: (s) => Number(s.fog.uniforms.far.value),
    set: (s, v) => (s.fog.uniforms.far.value = v),
  },
  {
    label: "Fog layer top",
    min: 0,
    max: 260,
    step: 1,
    get: (s) => Number(s.fog.uniforms.groundTop.value),
    set: (s, v) => (s.fog.uniforms.groundTop.value = v),
    hint: "ABSOLUTE world height — Green Mile's terrain runs about 5 to 174 m",
  },
  {
    label: "Fog layer base",
    min: 0,
    max: 260,
    step: 1,
    get: (s) => Number(s.fog.uniforms.groundBase.value),
    set: (s, v) => (s.fog.uniforms.groundBase.value = v),
    hint: "0 is ordinary ground fog. Raise it above the valley floor and the slab lifts off into a band — clear below, clear above, blind at one altitude",
  },
  {
    label: "Ground fog softness",
    min: 1,
    max: 80,
    step: 1,
    get: (s) => Number(s.fog.uniforms.groundScale.value),
    set: (s, v) => (s.fog.uniforms.groundScale.value = v),
    hint: "metres for density to fall by 1/e above the level — small is a sharp lid",
  },
  {
    label: "Ground fog density",
    min: 0,
    max: 0.02,
    step: 0.0002,
    get: (s) => Number(s.fog.uniforms.groundDensity.value),
    set: (s, v) => (s.fog.uniforms.groundDensity.value = v),
    // Range and step chosen from what the number does rather than from round figures:
    // optical depth reaches 1 — about 63% fogged — at 1/density metres, so 0.005 is
    // half-hidden at 140 m and the top of this dial is opaque within 50. Mild lives
    // between 0.001 and 0.004, which a 0.001 step could not reach.
    hint: "extinction per metre inside the layer; ~63% fogged at 1/density metres",
  },
];

const PRECIPITATION: Dial[] = [
  {
    label: "Rain",
    min: 0,
    max: 1,
    step: 0.01,
    get: (s) => Number(s.precipitation.uniforms.intensity.value),
    set: (s, v) => (s.precipitation.uniforms.intensity.value = v),
    hint: "fraction of the drop pool drawn",
  },
  {
    label: "Snow",
    min: 0,
    max: 1,
    step: 0.01,
    get: (s) => Number(s.precipitation.uniforms.mode.value),
    set: (s, v) => (s.precipitation.uniforms.mode.value = v),
    hint: "0 rain, 1 snow — between them is sleet",
  },
  {
    label: "Drop opacity",
    min: 0,
    max: 0.3,
    step: 0.005,
    get: (s) => Number(s.precipitation.uniforms.opacity.value),
    set: (s, v) => (s.precipitation.uniforms.opacity.value = v),
  },
  {
    label: "Fall speed",
    min: 0.5,
    max: 25,
    step: 0.5,
    get: (s) => Number(s.precipitation.uniforms.fallSpeedRain.value),
    set: (s, v) => (s.precipitation.uniforms.fallSpeedRain.value = v),
  },
];

const BLADES: Dial[] = [
  {
    label: "Brightness lift",
    min: 0.5,
    max: 3.5,
    step: 0.05,
    get: (s) => Number(s.blades?.lift.value ?? 0),
    set: (s, v) => s.blades && (s.blades.lift.value = v),
    hint: "the layer against the march — the dial that decides whether blades read",
  },
  {
    label: "Root/tip contrast",
    min: 0.1,
    max: 1,
    step: 0.01,
    get: (s) => Number(s.blades?.shadeBase.value ?? 0),
    set: (s, v) => s.blades && (s.blades.shadeBase.value = v),
    hint: "root brightness; the tip gets 2 minus this. NOT the same dial as lift",
  },
  {
    label: "Sun modulation",
    min: 0,
    max: 0.8,
    step: 0.01,
    get: (s) => Number(s.blades?.sun.value ?? 0),
    set: (s, v) => s.blades && (s.blades.sun.value = v),
    hint: "how much a blade facing the sun outshines one edge-on to it",
  },
  {
    label: "Field radius",
    min: 2,
    max: 40,
    step: 0.5,
    get: (s) => Number(s.blades?.radius.value ?? 0),
    set: (s, v) => s.blades && (s.blades.radius.value = v),
    hint: "metres. RAISING THIS LOWERS DENSITY — the count is fixed at load",
  },
  {
    label: "Thinning starts",
    min: 0,
    max: 20,
    step: 0.5,
    get: (s) => Number(s.blades?.thinStart.value ?? 0),
    set: (s, v) => s.blades && (s.blades.thinStart.value = v),
  },
  {
    label: "Player push",
    min: 0,
    max: 2,
    step: 0.05,
    get: (s) => Number(s.blades?.push.value ?? 0),
    set: (s, v) => s.blades && (s.blades.push.value = v),
    hint: "grass pushed aside is grass you can see through — keep it parting, not clearing",
  },
  {
    label: "Push radius",
    min: 0,
    max: 4,
    step: 0.1,
    get: (s) => Number(s.blades?.pushRadius.value ?? 0),
    set: (s, v) => s.blades && (s.blades.pushRadius.value = v),
  },
  {
    label: "Wind gain",
    min: 0,
    max: 0.3,
    step: 0.005,
    get: (s) => Number(s.blades?.windGain.value ?? 0),
    set: (s, v) => s.blades && (s.blades.windGain.value = v),
    hint: "lean per m/s. DIRECTION is not a dial — it is the vector that drifts bullets",
  },
  {
    label: "Resting bend",
    min: 0,
    max: 1.2,
    step: 0.01,
    get: (s) => Number(s.blades?.bend.value ?? 0),
    set: (s, v) => s.blades && (s.blades.bend.value = v),
  },
  {
    label: "Twist",
    min: 0,
    max: 6,
    step: 0.05,
    get: (s) => Number(s.blades?.twist.value ?? 0),
    set: (s, v) => s.blades && (s.blades.twist.value = v),
  },
];

function Group({
  title,
  dials,
  scene,
}: {
  title: string;
  dials: Dial[];
  scene: SceneHandles;
}): React.ReactElement {
  // Mirrored in React state only so the readout moves; the uniform is the source of
  // truth and is written directly.
  const [vals, setVals] = useState<number[]>(() => dials.map((d) => d.get(scene)));
  useEffect(() => setVals(dials.map((d) => d.get(scene))), [dials, scene]);

  return (
    <>
      <span className="eyebrow" style={{ marginTop: 10 }}>
        {title}
      </span>
      {dials.map((d, i) => (
        <label key={d.label} className="dial">
          <span className="dial-row">
            <span>{d.label}</span>
            <b>{vals[i]?.toFixed(d.step < 0.01 ? 3 : 2)}</b>
          </span>
          <input
            type="range"
            min={d.min}
            max={d.max}
            step={d.step}
            value={vals[i] ?? d.min}
            onChange={(e) => {
              const v = Number(e.target.value);
              d.set(scene, v);
              setVals((p) => p.map((x, j) => (j === i ? v : x)));
            }}
          />
          {d.hint && <em>{d.hint}</em>}
        </label>
      ))}
    </>
  );
}

export function WeatherDebug({ scene }: WeatherDebugProps): React.ReactElement | null {
  if (!scene) return null;
  const ids = Object.keys(WEATHER_PRESETS);

  return (
    <section className="panel" id="weatherdebug">
      <span className="eyebrow">Weather (live)</span>
      <div className="btns">
        {ids.map((id) => (
          <button
            key={id}
            aria-pressed={scene.preset.id === id}
            onClick={() => scene.setPreset(id)}
          >
            {id}
          </button>
        ))}
      </div>

      {/* Keyed on the preset so every readout re-seeds from the uniforms a switch just
          wrote — otherwise the sliders keep showing the previous preset's numbers while
          the picture has already changed, which is worse than showing nothing. */}
      <Group key={`a${scene.preset.id}`} title="Atmosphere" dials={ATMOSPHERE} scene={scene} />
      <Group key={`p${scene.preset.id}`} title="Precipitation" dials={PRECIPITATION} scene={scene} />
      {scene.blades && (
        <Group key={`b${scene.preset.id}`} title="Blades" dials={BLADES} scene={scene} />
      )}

      <p className="note">
        Switching a preset rewrites the grade, the fog and the rain in place — no material
        is rebuilt, so the terrain geometry cache survives and the comparison is honest.
        <br />
        Baked at load and still needing a reload: <code>?bladecount=</code>, which fixes
        the lattice the field radius divides up.
      </p>
    </section>
  );
}
