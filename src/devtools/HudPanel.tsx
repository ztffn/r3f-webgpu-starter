// "HUD" tab — live visibility switches for every in-game HUD panel, plus the
// panel-opacity dial. State lives in GameApp (it owns the HUD) and persists for
// the session, like the console's remembered tab: hiding the weapon block to
// stare at grass, reloading to rebake a URL parameter, and still not seeing the
// weapon block is the workflow; seeing it back next week is the safe reset.

import { memo } from "react";
import {
  HUD_PANELS,
  HUD_PANEL_LABELS,
  PANEL_ALPHA_MAX,
  PANEL_ALPHA_MIN,
  type HudPanelId,
  type HudPanelVisibility,
} from "../hud/hudPanels";

export interface HudPanelProps {
  panels: HudPanelVisibility;
  setPanel: (id: HudPanelId, visible: boolean) => void;
  setAllPanels: (visible: boolean) => void;
  panelAlpha: number;
  setPanelAlpha: (value: number) => void;
}

/**
 * Memoised like WeatherPanel and for the same reason: the console re-renders at
 * GameApp's telemetry rate (~13 Hz), and this tab's props only change on a click.
 */
export const HudPanel = memo(function HudPanel({
  panels,
  setPanel,
  setAllPanels,
  panelAlpha,
  setPanelAlpha,
}: HudPanelProps) {
  const allOn = HUD_PANELS.every((id) => panels[id]);

  return (
    <>
      <span className="eyebrow dev-group">Panels</span>
      <div className="btns" data-dev="hud-panels">
        {HUD_PANELS.map((id) => (
          <button
            key={id}
            type="button"
            data-dev={`hud-panel-${id}`}
            aria-pressed={panels[id]}
            onClick={() => setPanel(id, !panels[id])}
          >
            {HUD_PANEL_LABELS[id]}
          </button>
        ))}
      </div>
      <div className="btns" style={{ marginTop: "var(--s2)" }}>
        <button
          type="button"
          data-dev="hud-panels-all"
          onClick={() => setAllPanels(!allOn)}
        >
          {allOn ? "Hide all" : "Show all"}
        </button>
      </div>

      <span className="eyebrow dev-group">Opacity</span>
      <label className="dial">
        <span className="dial-row">
          Panel background <b data-dev-value={panelAlpha.toFixed(2)}>{panelAlpha.toFixed(2)}×</b>
        </span>
        <input
          type="range"
          data-dev="hud-panel-alpha"
          min={PANEL_ALPHA_MIN}
          max={PANEL_ALPHA_MAX}
          step={0.05}
          value={panelAlpha}
          onChange={(event) => setPanelAlpha(Number(event.target.value))}
        />
        <em>
          Multiplies the panels&apos; background opacity. 1× is the stylesheet default;
          the type and bars are unaffected so readouts stay legible at any setting.
        </em>
      </label>

      <p className="note">
        Combat feedback — hitmarker, damage direction, death overlay — has no switch
        on purpose: hidden feedback reads as a broken feedback wire. Two toggles are
        conditional by design: Objective renders only under <code>?hudpreview=1</code>,
        and Feed only once it has something true to say.
      </p>
    </>
  );
});
