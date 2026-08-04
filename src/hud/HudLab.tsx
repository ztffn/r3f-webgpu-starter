// HUD lab — the real HUD components over a still frame, with the reference
// mockup overlayable for a 1:1 comparison.
//
// This is the tool design/df2-hud-1to1-html-v3 shipped as a standalone page,
// pointed at the actual components instead of a copy of them. It exists because
// verifying the HUD by loading the game costs a terrain decode and a GPU, and on a
// slow or headless machine that is 30 seconds per look — so HUD work stopped being
// checkable at all in exactly the environment where it most needed checking.
//
// DEV ONLY. The route is registered inside an `import.meta.env.DEV` branch
// (src/site/routes.tsx), which Vite replaces with `false` in a production build,
// so this module and the two design images are dropped from the bundle.

import { useEffect, useState } from "react";
import { GameHud } from "./GameHud";
import "./hudlab.css";
import type { FlyState } from "../df2/FlyControls";
import { hudSignals } from "./hudSignals";

/** Served by the Vite dev server straight out of design/ — nothing is copied. */
const SCENE = "/design/df2-hud-1to1-html-v3/scene.jpg";
const REFERENCE = "/design/df2-hud-1to1-html-v3/reference.jpg";

type Mode = "hud" | "split" | "reference";

/**
 * A plausible fly state, so the panels that read one have something to show.
 *
 * Explicitly fake, and only ever reachable from this dev route — the HUD itself
 * still renders a dash for anything it has no real source for, and that behaviour
 * is the thing this page is most useful for checking.
 */
const SAMPLE_FLY: FlyState = {
  position: { x: 0, y: 41, z: 320 } as FlyState["position"],
  agl: 1.7,
  speed: 0,
  grounded: true,
  net: { phase: "playing", playerId: 1, health: 100 },
};

export default function HudLab() {
  const [mode, setMode] = useState<Mode>("hud");
  const [heading, setHeading] = useState(285);
  const [live, setLive] = useState(false);

  // Writes the signal the compass and rose read every frame. A range input rather
  // than a mouse drag so the heading is settable to an exact bearing.
  const applyHeading = (degrees: number) => {
    setHeading(degrees);
    hudSignals.headingRadians = (degrees * Math.PI) / 180;
  };

  // On mount too, not only on change: the signal is module state that the game
  // last wrote, so without this the slider showed 285° while the compass sat on
  // whatever bearing the previous route left behind.
  useEffect(() => {
    hudSignals.headingRadians = (heading * Math.PI) / 180;
    // Deliberately mount-only — `applyHeading` owns every later update, and
    // depending on `heading` here would fight the sweep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="hudlab">
      <div className="hudlab-controls">
        {(["hud", "split", "reference"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            data-dev={`hudlab-${m}`}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
          >
            {m === "hud" ? "HUD" : m === "split" ? "50/50" : "Reference"}
          </button>
        ))}
        <label>
          <span>Heading {heading}°</span>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={heading}
            data-dev="hudlab-heading"
            aria-label="Heading"
            onChange={(e) => applyHeading(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          data-dev="hudlab-live"
          aria-pressed={live}
          onClick={() => setLive(!live)}
        >
          Sweep
        </button>
      </div>

      <div className={`hudlab-stage mode-${mode}`}>
        <img className="hudlab-scene" src={SCENE} alt="" decoding="async" />
        {/* Mounted only when a mode actually shows it. At opacity 0 it is still a
            full-screen 1448x1086 image the compositor pays for every frame, which
            on a software renderer was enough to saturate the main thread and make
            the page stop responding entirely. */}
        {mode !== "hud" && (
          <img
            className="hudlab-reference"
            src={REFERENCE}
            alt="Reference mockup"
            decoding="async"
          />
        )}
        <GameHud fly={SAMPLE_FLY} fpsMode preview />
        {live && <HeadingSweep />}
      </div>
    </div>
  );
}

/**
 * Rotates the heading continuously, so the compass tape and the rose can be
 * checked for smoothness and for the wrap through 360° without a mouse.
 *
 * Writes only the signal, never React state: the compass reads the signal in its
 * own rAF loop, so re-rendering here would prove nothing and cost a commit per
 * frame. The label above simply stops tracking while the sweep runs, which is the
 * right trade for a dev harness.
 */
function HeadingSweep() {
  useEffect(() => {
    let frame = 0;
    let degrees = hudSignals.headingRadians * (180 / Math.PI);
    const tick = () => {
      degrees = (degrees + 0.4) % 360;
      hudSignals.headingRadians = (degrees * Math.PI) / 180;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return null;
}
