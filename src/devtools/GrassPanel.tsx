// Live grass-shader dials — the "Grass" tab of the dev console.
//
// Writes straight to uniform .value, so nothing re-renders and no material is
// rebuilt — rebuilding would throw away the terrain geometry cache and stall for
// a second, which makes A/B comparison useless.
//
// The coarse step COUNT is live (the loop compiles at a ceiling and runs to a uniform),
// but the ceiling itself and the bisection count are baked into the graph at construction
// and are listed at the bottom as URL parameters needing a reload.
//
// Every control carries `data-dev` and its current value, so browser automation can
// address a dial by name and assert what it set rather than screenshot and guess
// (docs/plans/2026-08-04-web-platform-and-ui-design.md §4).

import { memo, useEffect, useRef, useState } from "react";
import type { GrassUniforms } from "../df2/GrassMaterial";
import { GRASS_STEPS } from "../df2/config";
import { BENCH } from "../df2/bench";

export interface GrassPanelProps {
  uniforms: GrassUniforms | null;
}

interface Dial {
  key: keyof GrassUniforms;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

// The canopy height is ONE uniform in metres — it both scales the canopy field and
// bounds the march span. It used to be two holding the same number, written in
// lockstep from here; the slider now writes the one.
/**
 * The compiled loop ceiling. The march runs to the live `steps` uniform but the loop
 * is COMPILED at this count, so dragging past it changes the readout and nothing else.
 * Derived rather than a literal — it was 64 against a ceiling of 32, so the top half of
 * the one dial that sets frame time did nothing.
 */
const STEP_CEILING = Math.max(GRASS_STEPS, BENCH.steps ?? 0);

const DIALS: Dial[] = [
  {
    key: "canopyMax",
    label: "Canopy height",
    min: 0.2,
    max: 12,
    step: 0.1,
    hint: "metres for the tallest canopy — the 'length' dial",
  },
  {
    key: "cell",
    label: "Column width",
    min: 0.002,
    max: 2,
    step: 0.001,
    // Floor is the march, not the field: 12 coarse samples spread over metres already
    // make which column a ray hits partly arbitrary, and thinner columns turn that into
    // shimmer rather than detail. The jitter now resolves per column at any width.
    hint: "metres — below ~0.005 expect shimmer, not detail",
  },
  {
    key: "steps",
    label: "March steps",
    min: 1,
    max: STEP_CEILING,
    step: 1,
    // Capped by the COMPILED count — ?steps=N at load sets the ceiling, and this cannot
    // go above it. Load with ?steps=32 to sweep the whole range.
    hint: "coarse samples/fragment. Fewer = more horizontal layering. Ceiling = ?steps=",
  },
  { key: "tone", label: "Tone variation", min: 0, max: 1.5, step: 0.01, hint: "0 disables it" },
  {
    key: "strandMix",
    label: "Per-strand height",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "ragged canopy top. THE ONE DIAL THAT COSTS FPS — 0 is free",
  },
  {
    key: "shadeBase",
    label: "Base shading",
    min: 0.3,
    max: 1,
    step: 0.01,
    hint: "column base brightness; tip gets 2 minus this. 1 = flat",
  },
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
// Green Mile's canopy is a colormap-derived stand-in, so it is patchy and a frame can
// legitimately be mostly bare — which looks identical to the shader failing. Forcing
// full canopy separates the column renderer from the field feeding it.
const CANOPY_MODES = ["Field", "Everywhere"];
// 4-9 bisect the colour expression live, so isolating a bad term costs one build
// instead of one per term. 6-8 are banded false colour, not greyscale:
// black < 0.125, blue < 0.375, green < 0.625, yellow < 0.875, red above.
const DEBUG_MODES = [
  "Normal",
  "Hit mask",
  "Hit distance",
  "Height in column",
  "Columns",
  "Faded",
  "Fog factor",
  "Fog input",
  "Fade",
  "Fog colour",
];

/**
 * Memoised like its three sibling tabs: the console re-renders at GameApp's
 * telemetry rate (~13 Hz), and with this tab open that reconciled eleven range
 * inputs per tick. `uniforms` is identity-stable, so memo bails immediately.
 */
export const GrassPanel = memo(function GrassPanel({ uniforms }: GrassPanelProps) {
  // Mirror of uniform values, so the sliders have positions to show. Seeded once
  // from the material rather than from config, so it always reflects what is live.
  const [vals, setVals] = useState<Record<string, number>>({});
  const seeded = useRef(false);

  useEffect(() => {
    if (!uniforms || seeded.current) return;
    const next: Record<string, number> = {};
    for (const d of DIALS) next[d.key] = Number(uniforms[d.key].value);
    // canopyMax is a DIAL now, so the loop above already has it — it used to need a
    // second read here because the slider showed metres while the uniform held metres
    // x 255. One uniform, one unit, no special case.
    next.toneMode = Number(uniforms.toneMode.value);
    next.canopyForce = Number(uniforms.canopyForce.value);
    next.debugMode = Number(uniforms.debugMode.value);
    setVals(next);
    seeded.current = true;
  }, [uniforms]);

  if (!uniforms) return null;

  const write = (key: string, v: number) => {
    const dial = DIALS.find((d) => d.key === key);
    if (dial) uniforms[dial.key].value = v;
    setVals((p) => ({ ...p, [key]: v }));
  };

  /** One mode row. Three of these differ only by label, list and uniform. */
  const modeRow = (
    title: string,
    key: "toneMode" | "canopyForce" | "debugMode",
    modes: string[]
  ) => (
    <>
      <span className="eyebrow dev-group">{title}</span>
      <div className="btns" data-dev={`modes-${key}`} data-dev-value={vals[key] ?? 0}>
        {modes.map((m, i) => (
          <button
            key={m}
            type="button"
            data-dev={`${key}-${i}`}
            aria-pressed={(vals[key] ?? 0) === i}
            onClick={() => {
              uniforms[key].value = i;
              setVals((p) => ({ ...p, [key]: i }));
            }}
          >
            {m}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <>
      {DIALS.map((d) => (
        <label key={d.key} className="dial">
          <span className="dial-row">
            <span>{d.label}</span>
            <b data-dev={`readout-${d.key}`}>
              {(vals[d.key] ?? 0).toFixed(d.step < 0.01 ? 3 : 2)}
            </b>
          </span>
          <input
            type="range"
            // Both the machine name and the current value: a driver finds the
            // control by `data-dev` and asserts the result without reading pixels.
            data-dev={`dial-${d.key}`}
            data-dev-value={vals[d.key] ?? d.min}
            aria-label={d.label}
            min={d.min}
            max={d.max}
            step={d.step}
            value={vals[d.key] ?? d.min}
            onChange={(e) => write(d.key, Number(e.target.value))}
          />
          {d.hint && <em>{d.hint}</em>}
        </label>
      ))}

      {modeRow("Tone keyed on", "toneMode", TONE_MODES)}
      {modeRow("Canopy from", "canopyForce", CANOPY_MODES)}
      {modeRow("View", "debugMode", DEBUG_MODES)}

      <p className="note">
        <code>March steps</code> is live, but its CEILING is compiled — the slider stops at
        whatever <code>?steps=</code> was at load (default 32), and reloading reseeds it to
        the shipped running value rather than to where you left it.
        <br />
        Still baked, still needs a reload: <code>?refine=</code> bisections.
        <br />
        Frame time reacts immediately, but it is <b>vsync-capped at 8.3 ms</b> on a 120 Hz
        display — below that the counter cannot show an improvement, so read a change as
        &ldquo;still at the cap&rdquo; rather than as &ldquo;no effect&rdquo;. Use
        <code>?dpr=2</code> to push the frame off the cap when you need to see the
        difference a dial actually makes.
      </p>
    </>
  );
});
