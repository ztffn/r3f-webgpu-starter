// The dev console: one tabbed panel holding everything that used to sit on the
// game screen as nine separate debug panels.
//
// Three properties are requirements, not niceties (design record §4): it opens
// from a URL as well as a keystroke, every control is a real form element with a
// stable `data-dev` name, and the console publishes its own state to `data-*` so a
// driver can assert what it did instead of screenshotting and guessing.

import { useSyncExternalStore } from "react";
import { combatTelemetry } from "../fps/ui/CombatTelemetry";
import { DEV_TABS, type DevConsoleState, type DevTab } from "./useDevConsole";
import { ScenePanel, type ScenePanelProps } from "./ScenePanel";
import { TelemetryPanel } from "./TelemetryPanel";
import { ControlsPanel } from "./ControlsPanel";
import { GrassPanel } from "./GrassPanel";
import { WeatherPanel } from "./WeatherPanel";
import type { GrassUniforms } from "../df2/GrassMaterial";
import type { SceneHandles } from "../df2/DF2Scene";
import type { PerfSample } from "../df2/PerfMonitor";
import type { FlyState } from "../df2/FlyControls";
import "./devtools.css";

const TAB_LABELS: Record<DevTab, string> = {
  scene: "Scene",
  telemetry: "Telemetry",
  grass: "Grass",
  weather: "Weather",
  controls: "Controls",
};

export interface DevConsoleProps extends ScenePanelProps {
  state: DevConsoleState;
  perf: PerfSample | null;
  fly: FlyState | null;
  grassUniforms: GrassUniforms | null;
  scene: SceneHandles | null;
  fpsMode: boolean;
}

export function DevConsole({
  state,
  perf,
  fly,
  grassUniforms,
  scene,
  fpsMode,
  ...sceneProps
}: DevConsoleProps) {
  const combat = useSyncExternalStore(
    combatTelemetry.subscribe,
    combatTelemetry.getSnapshot,
    combatTelemetry.getSnapshot
  );

  // Closed, only the reopen tab renders. Deliberately still in the DOM: a driver
  // that expects `[data-dev="console-open"]` to exist needs something to click,
  // and a fully unmounted console gives it nothing to find.
  if (!state.open) {
    return (
      <button
        type="button"
        className="dev-reopen skin-hud"
        data-dev="console-open"
        onClick={state.toggle}
      >
        Dev `
      </button>
    );
  }

  return (
    <section
      className="dev-console skin-hud"
      data-dev="console"
      data-dev-open="true"
      data-dev-tab={state.tab}
      aria-label="Developer console"
    >
      <header className="dev-head">
        <div className="dev-tabs" role="tablist" aria-label="Developer console sections">
          {DEV_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`dev-tab-${tab}`}
              data-dev={`tab-${tab}`}
              aria-selected={state.tab === tab}
              aria-controls={`dev-panel-${tab}`}
              onClick={() => state.setTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="dev-close"
          data-dev="console-close"
          onClick={state.close}
        >
          <span className="sr-only">Close developer console</span>
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <div
        className="dev-body"
        role="tabpanel"
        id={`dev-panel-${state.tab}`}
        aria-labelledby={`dev-tab-${state.tab}`}
      >
        {state.tab === "scene" && <ScenePanel {...sceneProps} />}
        {state.tab === "telemetry" && (
          <TelemetryPanel perf={perf} fly={fly} combat={combat} />
        )}
        {state.tab === "grass" && <GrassPanel uniforms={grassUniforms} />}
        {state.tab === "weather" && <WeatherPanel scene={scene} />}
        {state.tab === "controls" && <ControlsPanel fpsMode={fpsMode} />}
      </div>
    </section>
  );
}
