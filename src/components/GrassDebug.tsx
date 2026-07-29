// Live slider panel for the grass shader, shown with ?debug=1.
//
// Writes straight to uniform .value, so nothing re-renders and no material is
// rebuilt — rebuilding would throw away the terrain geometry cache and stall for
// a second, which makes A/B comparison useless.
//
// Two loop counts and the hash wrap period are baked into the shader graph at
// construction and cannot be sliders; they are listed at the bottom as URL
// parameters that need a reload.

import { useEffect, useRef, useState } from "react";
import type { GrassUniforms } from "../df2/GrassMaterial";

export interface GrassDebugProps {
  uniforms: GrassUniforms | null;
}

interface Dial {
  key: keyof GrassUniforms;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Written to a second uniform in lockstep — canopyMax tracks grassScale. */
  also?: keyof GrassUniforms;
  hint?: string;
}

// grassScale and canopyMax are the same quantity at two scalings: the shader
// stores grassScale pre-multiplied by 255 (metres per raw unit x 255) while
// canopyMax is the resulting metres for a raw 255. Slide metres, write both.
const DIALS: Dial[] = [
  {
    key: "grassScale",
    label: "Canopy height",
    min: 0.2,
    max: 12,
    step: 0.1,
    also: "canopyMax",
    hint: "metres for the tallest canopy — the 'length' dial",
  },
  { key: "cell", label: "Column width", min: 0.01, max: 2, step: 0.01, hint: "metres" },
  { key: "tone", label: "Tone variation", min: 0, max: 1.5, step: 0.01, hint: "0 disables it" },
  {
    key: "stripePixels",
    label: "Stripe width",
    min: 1,
    max: 40,
    step: 1,
    hint: "pixels — only used by bearing tone",
  },
  { key: "nearClip", label: "Near clip", min: 0.05, max: 8, step: 0.05, hint: "metres from the eye" },
  { key: "maxSpan", label: "Max ray span", min: 2, max: 300, step: 1, hint: "metres" },
  { key: "fadeStart", label: "Fade start", min: 50, max: 2000, step: 10, hint: "metres" },
  { key: "fadeEnd", label: "Fade end", min: 100, max: 3000, step: 10, hint: "metres" },
];

const TONE_MODES = ["World cell", "Ray bearing"];
const DEBUG_MODES = ["Normal", "Hit mask", "Hit distance", "Height in column"];

export function GrassDebug({ uniforms }: GrassDebugProps) {
  // Mirror of uniform values, so the sliders have positions to show. Seeded once
  // from the material rather than from config, so it always reflects what is live.
  const [vals, setVals] = useState<Record<string, number>>({});
  const seeded = useRef(false);

  useEffect(() => {
    if (!uniforms || seeded.current) return;
    const next: Record<string, number> = {};
    for (const d of DIALS) next[d.key] = Number(uniforms[d.key].value);
    // Shown in metres; the uniform holds metres x 255.
    next.grassScale = Number(uniforms.canopyMax.value);
    next.toneMode = Number(uniforms.toneMode.value);
    next.debugMode = Number(uniforms.debugMode.value);
    setVals(next);
    seeded.current = true;
  }, [uniforms]);

  if (!uniforms) return null;

  const write = (key: string, v: number) => {
    const dial = DIALS.find((d) => d.key === key);
    if (dial?.key === "grassScale") {
      // metres -> the shader's pre-multiplied form, and the span bound alongside.
      uniforms.grassScale.value = v;
      uniforms.canopyMax.value = v;
    } else if (dial) {
      uniforms[dial.key].value = v;
    }
    setVals((p) => ({ ...p, [key]: v }));
  };

  return (
    <section className="panel" id="grassdebug">
      <span className="eyebrow">Grass (live)</span>

      {DIALS.map((d) => (
        <label key={d.key} className="dial">
          <span className="dial-row">
            <span>{d.label}</span>
            <b>{(vals[d.key] ?? 0).toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={d.min}
            max={d.max}
            step={d.step}
            value={vals[d.key] ?? d.min}
            onChange={(e) => write(d.key, Number(e.target.value))}
          />
          {d.hint && <em>{d.hint}</em>}
        </label>
      ))}

      <span className="eyebrow" style={{ marginTop: 10 }}>
        Tone keyed on
      </span>
      <div className="btns">
        {TONE_MODES.map((m, i) => (
          <button
            key={m}
            aria-pressed={(vals.toneMode ?? 0) === i}
            onClick={() => {
              uniforms.toneMode.value = i;
              setVals((p) => ({ ...p, toneMode: i }));
            }}
          >
            {m}
          </button>
        ))}
      </div>

      <span className="eyebrow" style={{ marginTop: 10 }}>
        View
      </span>
      <div className="btns">
        {DEBUG_MODES.map((m, i) => (
          <button
            key={m}
            aria-pressed={(vals.debugMode ?? 0) === i}
            onClick={() => {
              uniforms.debugMode.value = i;
              setVals((p) => ({ ...p, debugMode: i }));
            }}
          >
            {m}
          </button>
        ))}
      </div>

      <p className="note">
        Baked into the shader — these need a reload:
        <br />
        <code>?steps=</code> coarse samples, <code>?refine=</code> bisections
      </p>
    </section>
  );
}
