// "Launch" tab — every URL parameter the game reads, as form controls that bake
// a fresh /play URL and reload into it. Reload, not live: scene/motor/net and the
// bench dials are read once at mount by design (a half-reconfigured scene is
// worse than a reload), so this panel is the honest UI for them — it edits the
// URL those parameters actually come from, and says so on its Apply button.

import { useMemo, useState } from "react";
import { WEATHER_PRESET_IDS } from "../df2/weather";

/** The scene the URL asks for. "" is the default (networked scope demo). */
const SCENES = [
  { value: "", label: "default" },
  { value: "scope", label: "scope" },
  { value: "weapon", label: "weapon" },
  { value: "motor", label: "motor" },
  { value: "terrain", label: "terrain (fly)" },
] as const;

interface LaunchState {
  scene: string;
  motor: boolean;
  net: boolean;
  server: string;
  room: string;
  label: string;
  touch: boolean;
  weather: string;
  debug: boolean;
  hud: boolean;
  hudpreview: boolean;
  loadout: "default" | "force" | "skip";
  blades: boolean;
  canopyall: boolean;
  crosshair: boolean;
  shotdebug: boolean;
  impacttest: boolean;
  weaponanim: boolean;
  bench: boolean;
  extras: string;
}

/** Everything this panel owns, read back out of the CURRENT url. */
function readCurrent(): LaunchState {
  const q = new URLSearchParams(window.location.search);
  const known = new Set([
    "scene", "motor", "net", "server", "room", "label", "input", "weather",
    "debug", "hud", "hudpreview", "loadout", "blades", "canopyall", "crosshair",
    "shotdebug", "impacttest", "weaponanim", "bench",
  ]);
  // Parameters this panel has no control for (dpr, steps, walk, fog dials …)
  // survive round trips through the free-text field instead of being dropped.
  const extras: string[] = [];
  q.forEach((value, key) => {
    if (!known.has(key)) extras.push(`${key}=${value}`);
  });
  const loadout = q.get("loadout");
  return {
    scene: q.get("scene") ?? "",
    motor: q.get("motor") === "1",
    net: q.get("net") === "1",
    server: q.get("server") ?? "",
    room: q.get("room") ?? "",
    label: q.get("label") ?? "",
    touch: q.get("input") === "touch",
    weather: q.get("weather") ?? "",
    debug: q.get("debug") === "1",
    hud: q.get("hud") !== "0",
    hudpreview: q.get("hudpreview") === "1",
    loadout: loadout === "1" ? "force" : loadout === "0" ? "skip" : "default",
    blades: q.get("blades") !== "0",
    canopyall: q.get("canopyall") === "1",
    crosshair: q.get("crosshair") !== "0",
    shotdebug: q.get("shotdebug") === "1",
    impacttest: q.get("impacttest") === "1",
    weaponanim: q.get("weaponanim") === "1",
    bench: q.get("bench") === "1",
    extras: extras.join("&"),
  };
}

/** Only non-defaults, so the baked URL stays as short as the documented ones. */
function buildSearch(s: LaunchState): string {
  const q = new URLSearchParams();
  if (s.scene !== "") q.set("scene", s.scene);
  if (s.motor) q.set("motor", "1");
  if (s.net) q.set("net", "1");
  if (s.server !== "") q.set("server", s.server);
  if (s.room !== "") q.set("room", s.room);
  if (s.label !== "") q.set("label", s.label);
  if (s.touch) q.set("input", "touch");
  if (s.weather !== "") q.set("weather", s.weather);
  if (s.debug) q.set("debug", "1");
  if (!s.hud) q.set("hud", "0");
  if (s.hudpreview) q.set("hudpreview", "1");
  if (s.loadout === "force") q.set("loadout", "1");
  if (s.loadout === "skip") q.set("loadout", "0");
  if (!s.blades) q.set("blades", "0");
  if (s.canopyall) q.set("canopyall", "1");
  if (!s.crosshair) q.set("crosshair", "0");
  if (s.shotdebug) q.set("shotdebug", "1");
  if (s.impacttest) q.set("impacttest", "1");
  if (s.weaponanim) q.set("weaponanim", "1");
  if (s.bench) q.set("bench", "1");
  let search = q.toString();
  const extras = s.extras.replace(/^[?&]+/, "").trim();
  if (extras !== "") search = search === "" ? extras : `${search}&${extras}`;
  return search;
}

function Flag({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button type="button" data-dev={`launch-${id}`} aria-pressed={value} onClick={() => onChange(!value)}>
      {label}
    </button>
  );
}

export function LaunchPanel() {
  const [state, setState] = useState<LaunchState>(readCurrent);
  const set = <K extends keyof LaunchState>(key: K, value: LaunchState[K]) =>
    setState((was) => ({ ...was, [key]: value }));

  const search = useMemo(() => buildSearch(state), [state]);
  const url = search === "" ? "/play" : `/play?${search}`;

  return (
    <>
      <span className="eyebrow dev-group">Scene</span>
      <div className="btns" data-dev="launch-scene" data-dev-value={state.scene || "default"}>
        {SCENES.map((scene) => (
          <button
            key={scene.value}
            type="button"
            data-dev={`launch-scene-${scene.label.split(" ")[0]}`}
            aria-pressed={state.scene === scene.value}
            onClick={() => set("scene", scene.value)}
          >
            {scene.label}
          </button>
        ))}
      </div>
      <div className="btns" style={{ marginTop: "var(--s2)" }}>
        <Flag id="motor" label="motor" value={state.motor} onChange={(v) => set("motor", v)} />
        <Flag id="net" label="net" value={state.net} onChange={(v) => set("net", v)} />
        <Flag id="bench" label="bench" value={state.bench} onChange={(v) => set("bench", v)} />
      </div>
      <p className="note" style={{ borderTop: 0, paddingTop: 0 }}>
        A bare <code>/play</code> stops at the loadout screen and then runs{" "}
        <code>scene=scope&amp;motor=1&amp;net=1</code>; explicit parameters take the URL
        at its word.
      </p>

      <span className="eyebrow dev-group">Session</span>
      <label className="dial">
        <span className="dial-row">server</span>
        <input
          type="text"
          data-dev="launch-server"
          value={state.server}
          placeholder="same origin (dev: ws://localhost:2567)"
          onChange={(event) => set("server", event.target.value)}
        />
      </label>
      <label className="dial">
        <span className="dial-row">room</span>
        <input
          type="text"
          data-dev="launch-room"
          value={state.room}
          placeholder="matchmake"
          onChange={(event) => set("room", event.target.value)}
        />
      </label>
      <label className="dial">
        <span className="dial-row">label</span>
        <input
          type="text"
          data-dev="launch-label"
          value={state.label}
          placeholder="callsign shown to others"
          onChange={(event) => set("label", event.target.value)}
        />
      </label>
      <div className="btns" style={{ marginTop: "var(--s2)" }}>
        <Flag id="touch" label="touch queue" value={state.touch} onChange={(v) => set("touch", v)} />
      </div>

      <span className="eyebrow dev-group">Weather</span>
      <label className="dial">
        <select
          data-dev="launch-weather"
          value={state.weather}
          onChange={(event) => set("weather", event.target.value)}
        >
          <option value="">default (day)</option>
          {WEATHER_PRESET_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <em>Offline only — a networked room owns its weather and ignores this.</em>
      </label>

      <span className="eyebrow dev-group">HUD &amp; debug</span>
      <div className="btns">
        <Flag id="debug" label="console open" value={state.debug} onChange={(v) => set("debug", v)} />
        {/* `hud=0` starts every panel hidden; `hudpreview` is only the two
            mockup panels that have no data source — the name predates this. */}
        <Flag id="hud" label="hud" value={state.hud} onChange={(v) => set("hud", v)} />
        <Flag id="hudpreview" label="mock panels" value={state.hudpreview} onChange={(v) => set("hudpreview", v)} />
        <Flag id="crosshair" label="crosshair" value={state.crosshair} onChange={(v) => set("crosshair", v)} />
        <Flag id="shotdebug" label="shot debug" value={state.shotdebug} onChange={(v) => set("shotdebug", v)} />
        <Flag id="impacttest" label="impact test" value={state.impacttest} onChange={(v) => set("impacttest", v)} />
        <Flag id="weaponanim" label="weapon anim" value={state.weaponanim} onChange={(v) => set("weaponanim", v)} />
      </div>

      <span className="eyebrow dev-group">World</span>
      <div className="btns">
        <Flag id="blades" label="blades" value={state.blades} onChange={(v) => set("blades", v)} />
        <Flag id="canopyall" label="canopy all" value={state.canopyall} onChange={(v) => set("canopyall", v)} />
      </div>

      <span className="eyebrow dev-group">Loadout stop</span>
      <div className="btns" data-dev="launch-loadout" data-dev-value={state.loadout}>
        {(["default", "force", "skip"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            data-dev={`launch-loadout-${mode}`}
            aria-pressed={state.loadout === mode}
            onClick={() => set("loadout", mode)}
          >
            {mode}
          </button>
        ))}
      </div>

      <span className="eyebrow dev-group">Extra parameters</span>
      <label className="dial">
        <input
          type="text"
          data-dev="launch-extras"
          value={state.extras}
          placeholder="dpr=0.8&steps=24&walk=6"
          onChange={(event) => set("extras", event.target.value)}
        />
        <em>Appended verbatim — bench dials, motor tuning, fog overrides, anything.</em>
      </label>

      <span className="eyebrow dev-group">URL</span>
      <p className="launch-url" data-dev="launch-url">
        {url}
      </p>
      <div className="btns">
        <button
          type="button"
          data-dev="launch-apply"
          onClick={() => window.location.assign(url)}
        >
          Apply &amp; reload
        </button>
        <button
          type="button"
          data-dev="launch-copy"
          onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${url}`)}
        >
          Copy URL
        </button>
      </div>
    </>
  );
}
