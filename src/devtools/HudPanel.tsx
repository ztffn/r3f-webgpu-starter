// "HUD" tab — live visibility switches for every in-game HUD panel, plus the
// panel-opacity dial. State lives in GameApp (it owns the HUD) and persists for
// the session, like the console's remembered tab: hiding the weapon block to
// stare at grass, reloading to rebake a URL parameter, and still not seeing the
// weapon block is the workflow; seeing it back next week is the safe reset.

import { HUD_PANELS, HUD_PANEL_LABELS, type HudPanelId, type HudPanelVisibility } from "../hud/hudPanels";

export interface HudPanelProps {
  panels: HudPanelVisibility;
  setPanel: (id: HudPanelId, visible: boolean) => void;
  panelAlpha: number;
  setPanelAlpha: (value: number) => void;
}

export function HudPanel({ panels, setPanel, panelAlpha, setPanelAlpha }: HudPanelProps) {
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
          onClick={() => HUD_PANELS.forEach((id) => setPanel(id, !allOn))}
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
          min={0.2}
          max={1.6}
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
        on purpose: hidden feedback reads as a broken feedback wire.
      </p>
    </>
  );
}
