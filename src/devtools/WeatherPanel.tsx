// Weather, atmosphere, rain and near-field blade dials — the "Weather" tab.
//
// Sibling of GrassPanel and the same contract: offline, every control writes straight
// to a uniform, so nothing re-renders and no material is rebuilt. That is not a nicety
// here — rebuilding discards the terrain geometry cache and stalls for about a second,
// which makes exactly the A/B comparison these dials exist for impossible.
//
// Networked, a dial is an ASK instead of a write: the server owns the room's values, so
// the control sends an intent and adopts whatever comes back. The dial table itself
// lives in src/df2/visualDials.ts, shared with that server.

import { memo } from "react";
import type { SceneHandles } from "../df2/DF2Scene";
import { WEATHER_PRESET_IDS } from "../df2/weather";
import { DialGroup, GROUPED } from "./dialGroup";

export interface WeatherPanelProps {
  scene: SceneHandles | null;
}

/**
 * MEMOISED. The HUD publishes fly state every 0.15 s and a perf sample every 0.5 s, so an
 * unmemoised panel reconciles twenty range inputs about seven times a second on telemetry
 * it does not read. `scene` only changes identity on a preset switch, on a room dial
 * packet, or when the admin gate changes.
 */
export const WeatherPanel = memo(function WeatherPanel({
  scene,
}: WeatherPanelProps): React.ReactElement | null {
  if (!scene) return null;
  // The room owns the weather when there is one, so a local switch is refused; and
  // whether the dials may be moved is on that object. Both DERIVED here rather than
  // published as separate flags — they are the same fact told three ways.
  const room = scene.roomDials;

  return (
    <>
      <span className="eyebrow dev-group">Preset</span>
      <div className="btns" data-dev="weather-presets" data-dev-value={scene.preset.id}>
        {WEATHER_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            data-dev={`preset-${id}`}
            aria-pressed={scene.preset.id === id}
            disabled={room !== null}
            onClick={() => scene.setPreset(id)}
          >
            {id}
          </button>
        ))}
      </div>
      {room !== null && (
        <p className="note">
          The server picks the weather for this room, so the buttons above are inert — fog
          is concealment here, and two players under different fog ranges is a fairness
          bug.
          <br />
          {room.dialsAllowed ? (
            <>
              <b>Admin.</b> The dials below change the room for <em>everyone</em>. They go
              to the server, which clamps them and broadcasts the result, so a slider that
              settles somewhere other than where you left it was clamped, not ignored.
            </>
          ) : (
            <>
              The dials are read-only: this server did not start with the admin flag set.
              They show what the room is running.
            </>
          )}
        </p>
      )}

      {/* Keyed on the preset so every readout re-seeds from the uniforms a switch just
          wrote — otherwise the sliders keep showing the previous preset's numbers while
          the picture has already changed, which is worse than showing nothing. */}
      <DialGroup
        key={`a${scene.preset.id}`}
        title="Atmosphere"
        ids={GROUPED.atmosphere}
        scene={scene}
      />
      <DialGroup
        key={`p${scene.preset.id}`}
        title="Precipitation"
        ids={GROUPED.precipitation}
        scene={scene}
      />
      {scene.blades && (
        <DialGroup key={`b${scene.preset.id}`} title="Blades" ids={GROUPED.blades} scene={scene} />
      )}

      <p className="note">
        Switching a preset rewrites the grade, the fog and the rain in place — no material
        is rebuilt, so the terrain geometry cache survives and the comparison is honest.
        <br />
        Baked at load and still needing a reload: <code>?bladecount=</code>, which fixes
        the lattice the field radius divides up.
      </p>
    </>
  );
});
