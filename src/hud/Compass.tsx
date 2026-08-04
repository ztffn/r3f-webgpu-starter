// Top-edge compass strip: a sliding tape of bearings under a fixed index mark.
//
// Reads hudSignals in its own rAF loop and writes the tape's transform directly,
// so turning costs one style write per frame and zero React renders. Going through
// state would either step at the 6.7 Hz FlyState report rate or re-render the whole
// HUD sixty times a second; neither is acceptable for the one element that moves
// whenever the player looks anywhere.
//
// All the arithmetic lives in compassTape.ts, which is pure and tested — rAF does
// not fire in a headless tab, so anything computed inline here would be
// unverifiable in the environment where this gets checked.

import { memo, useEffect, useRef } from "react";
import { hudSignals } from "./hudSignals";
import { buildTicks, tapeOffsetPx } from "./compassTape";

const TICKS = buildTicks();

/**
 * MEMOISED, and it matters more than it looks. GameHud re-renders whenever fly
 * state (0.15 s) or combat telemetry (0.16 s) updates — about 13 times a second —
 * and each render rebuilt all 216 tick elements with 216 fresh inline style
 * objects, on the same main thread that owes the canvas 60 fps. This component
 * takes no props and drives itself from hudSignals, so the output never depended
 * on that render in the first place.
 */
export const Compass = memo(function Compass() {
  const tape = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    let lastWhole = -1;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const node = tape.current;
      if (node === null) return;

      const degrees = (hudSignals.headingRadians * 180) / Math.PI;
      node.style.transform = `translate3d(${tapeOffsetPx(degrees)}px, 0, 0)`;

      // The numeric readout only changes on whole degrees, so skip the DOM write
      // on the other ~59 frames a second.
      const whole = Math.round(degrees) % 360;
      if (whole !== lastWhole && readout.current !== null) {
        lastWhole = whole;
        readout.current.textContent = `${String(whole).padStart(3, "0")}°`;
      }
    };

    tick();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="hud-compass" data-dev="hud-compass">
      <div className="hud-compass-window">
        <div className="hud-compass-tape" ref={tape}>
          {TICKS.map((t) => (
            <span
              key={t.absolute}
              className={`hud-tick${t.major ? " major" : ""}${
                t.label !== null && !/\d/.test(t.label) ? " cardinal" : ""
              }`}
              style={{ left: `${t.offsetPx}px` }}
            >
              <i />
              {t.label && <b>{t.label}</b>}
            </span>
          ))}
        </div>
      </div>
      <span className="hud-compass-index" aria-hidden="true" />
      <span className="hud-compass-readout" ref={readout}>
        000°
      </span>
    </div>
  );
});
