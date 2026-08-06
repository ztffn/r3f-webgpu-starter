// The nav panel's compass rose.
//
// Rotates the ring against a fixed forward index, so the labels behave like a
// real instrument: N stays pointing north while the aircraft symbol stays up.
// Driven from hudSignals in a rAF loop for the same reason the compass strip is —
// heading changes every frame and must not cost a React render.
//
// It plots no contacts. There is no contact source: offline nothing else exists,
// and networked the remote players are known to GameClient but not yet published
// anywhere the HUD can read. An empty rose is honest; invented blips are not.

import { memo, useEffect, useRef } from "react";
import { hudSignals } from "./hudSignals";

/** Memoised for the same reason as Compass: no props, self-driven from hudSignals. */
export const RadarRose = memo(function RadarRose() {
  const ring = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const node = ring.current;
      if (node === null) return;
      // Negated: turning right must swing the ring left for the labels to stay
      // put in the world while the index mark stays at the top of the screen.
      node.style.transform = `rotate(${(-hudSignals.headingRadians * 180) / Math.PI}deg)`;
    };
    // Called directly, not scheduled: this writes the correct orientation on mount
    // rather than one frame later, so the rose is right in a screenshot taken
    // immediately — and in a tab where rAF never fires at all.
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="hud-radar" data-dev="hud-radar">
      <div className="hud-radar-ring" ref={ring}>
        <span className="n">N</span>
        <span className="e">E</span>
        <span className="s">S</span>
        <span className="w">W</span>
      </div>
      <span className="hud-radar-self" aria-hidden="true">
        ▲
      </span>
    </div>
  );
});
