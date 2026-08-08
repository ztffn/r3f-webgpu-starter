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
import { HudPanel, type HudPanelProps } from "./HudPanel";
import { LaunchPanel } from "./LaunchPanel";
import { TelemetryPanel } from "./TelemetryPanel";
import { ControlsPanel } from "./ControlsPanel";
import { GrassPanel } from "./GrassPanel";
import { WeatherPanel } from "./WeatherPanel";
import type { GrassUniforms } from "../df2/GrassMaterial";
import type { SceneHandles } from "../df2/DF2Scene";
import type { FoliageDebugControls } from "../foliage/foliageDebug";
import { FoliagePanel } from "./FoliagePanel";
import type { PerfSample } from "../df2/PerfMonitor";
import type { FlyState } from "../df2/FlyControls";
import "./devtools.css";

const TAB_LABELS: Record<DevTab, string> = {
  scene: "Scene",
  hud: "HUD",
  launch: "Launch",
  telemetry: "Telemetry",
  grass: "Grass",
  foliage: "Foliage",
  weather: "Weather",
  controls: "Controls",
};

export interface DevConsoleProps extends ScenePanelProps, HudPanelProps {
  state: DevConsoleState;
  perf: PerfSample | null;
  fly: FlyState | null;
  grassUniforms: GrassUniforms | null;
  foliageControls: FoliageDebugControls | null;
  scene: SceneHandles | null;
  fpsMode: boolean;
}

export function DevConsole({
  state,
  perf,
  fly,
  grassUniforms,
  foliageControls,
  scene,
  fpsMode,
  panels,
  setPanel,
  setAllPanels,
  panelAlpha,
  setPanelAlpha,
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
        {/* Toggle buttons, not the ARIA tabs pattern: `role="tab"` promises
            arrow-key navigation and a roving tabindex, and announced "tab 1 of
            7" while the keys did nothing. `aria-pressed` describes what these
            actually are. The panel below keeps its labelled region. */}
        <div className="dev-tabs" role="group" aria-label="Developer console sections">
          {DEV_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              id={`dev-tab-${tab}`}
              data-dev={`tab-${tab}`}
              aria-pressed={state.tab === tab}
              aria-controls={`dev-panel-${tab}`}
              onClick={() => state.setTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
        {/* Closing removes the focused element, so focus is handed to the
            reopen tab — which is kept mounted for this reason — rather than
            falling to <body> and losing a keyboard user's place. */}
        <button
          type="button"
          className="dev-close"
          data-dev="console-close"
          onClick={() => {
            state.close();
            requestAnimationFrame(() => {
              document.querySelector<HTMLElement>('[data-dev="console-open"]')?.focus();
            });
          }}
        >
          <span className="sr-only">Close developer console</span>
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <div
        className="dev-body"
        role="region"
        id={`dev-panel-${state.tab}`}
        aria-labelledby={`dev-tab-${state.tab}`}
      >
        {state.tab === "scene" && <ScenePanel {...sceneProps} scene={scene} />}
        {state.tab === "hud" && (
          <HudPanel
            panels={panels}
            setPanel={setPanel}
            setAllPanels={setAllPanels}
            panelAlpha={panelAlpha}
            setPanelAlpha={setPanelAlpha}
          />
        )}
        {state.tab === "launch" && <LaunchPanel />}
        {state.tab === "telemetry" && (
          <TelemetryPanel perf={perf} fly={fly} combat={combat} />
        )}
        {state.tab === "grass" && <GrassPanel uniforms={grassUniforms} />}
        {state.tab === "foliage" && (
          <FoliagePanel
            scene={scene}
            controls={foliageControls}
            networked={sceneProps.networked}
          />
        )}
        {state.tab === "weather" && <WeatherPanel scene={scene} />}
        {state.tab === "controls" && <ControlsPanel fpsMode={fpsMode} />}
      </div>
    </section>
  );
}
