// Live panel for weather, atmosphere, rain and the near-field blades, with ?debug=1.
//
// Sibling of GrassDebug and the same contract: offline, every control writes straight
// to a uniform, so nothing re-renders and no material is rebuilt. That is not a nicety
// here — rebuilding discards the terrain geometry cache and stalls for about a second,
// which makes exactly the A/B comparison these dials exist for impossible.
//
// Networked, a dial is an ASK instead of a write: the server owns the room's values, so
// the control sends an intent and adopts whatever comes back. The dial table itself
// lives in src/df2/visualDials.ts, shared with that server.

import { memo, useEffect, useRef, useState } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import type { SceneHandles } from "../df2/DF2Scene";
import { WEATHER_PRESET_IDS } from "../df2/weather";
import { VISUAL_DIALS, type VisualDialGroup } from "../df2/visualDials";
import type { RoomVisuals } from "../fps/useRoomVisuals";

export interface WeatherDebugProps {
  scene: SceneHandles | null;
}

/** Dial ids by group, resolved once. Ids are indices into the shared table. */
const GROUPED: Record<VisualDialGroup, number[]> = {
  atmosphere: [],
  precipitation: [],
  blades: [],
};
VISUAL_DIALS.forEach((dial, id) => GROUPED[dial.group].push(id));

/**
 * What a dial currently reads: the room's override if it has one, else the live
 * uniform the preset last wrote.
 *
 * Shared by the seed and the resync below, which is the point — written twice, a
 * change to the precedence makes a slider seed from one rule and resync to another,
 * visible only as a readout that jumps on the first packet after mount.
 */
function dialValue(room: RoomVisuals | null, scene: SceneHandles, id: number): number {
  return room?.overrides.get(id) ?? VISUAL_DIALS[id]!.get(scene);
}

function Group({
  title,
  ids,
  scene,
}: {
  title: string;
  ids: number[];
  scene: SceneHandles;
}): React.ReactElement {
  const room = scene.roomDials;
  // Mirrored in React state only so the readout moves. Offline the uniform is the
  // source of truth and is written directly; networked the ROOM is, and this mirror
  // is optimistic — it moves with the drag and is overwritten by what comes back.
  // Seeded once per mount. The caller keys each Group on the preset id, so a switch
  // remounts and re-runs this initializer — an effect doing the same job could only ever
  // fire redundantly.
  const [vals, setVals] = useState<number[]>(() =>
    ids.map((id) => dialValue(room, scene, id))
  );

  /**
   * The dial the user is physically holding, or null.
   *
   * This exists because the server echoes at the patch rate while a drag produces
   * values continuously: adopting every echo would keep resetting the slider to a
   * value from 50 ms ago, which reads as the control fighting back. The dial under
   * the pointer keeps its local value; every other dial follows the room, so a
   * second admin's changes still show up live.
   */
  const held = useRef<number | null>(null);

  useEffect(() => {
    if (room === null) return;
    setVals((previous) => {
      // RETURN THE SAME ARRAY when nothing moved, so React bails out instead of
      // committing a render. Nothing-moved is the NORMAL case for the group being
      // dragged — the held dial keeps its local value and its neighbours did not
      // change — so without this every packet costs a wasted render pass per group.
      let changed = false;
      const next = ids.map((id, index) => {
        const was = previous[index]!;
        if (held.current === id) return was;
        const now = dialValue(room, scene, id);
        if (now !== was) changed = true;
        return now;
      });
      return changed ? next : previous;
    });
    // `room` is a fresh object per server packet, which is what makes this fire.
  }, [room, ids, scene]);

  return (
    <>
      <span className="eyebrow" style={{ marginTop: 10 }}>
        {title}
      </span>
      {ids.map((id, i) => {
        const d = VISUAL_DIALS[id]!;
        return (
          <label key={d.label} className="dial">
            <span className="dial-row">
              <span>{d.label}</span>
              <b>{vals[i]?.toFixed(d.step < 0.01 ? 3 : 2)}</b>
            </span>
            <input
              type="range"
              min={d.min}
              max={d.max}
              step={d.step}
              value={vals[i] ?? d.min}
              disabled={room !== null && !room.dialsAllowed}
              onPointerDown={() => (held.current = id)}
              onPointerUp={() => (held.current = null)}
              onFocus={() => (held.current = id)}
              onBlur={() => (held.current = null)}
              onChange={(e) => {
                const v = Number(e.target.value);
                // Networked, do NOT write the uniform: the server's echo applies it,
                // so a refused or clamped write shows as the slider settling on the
                // real value instead of the picture and the room disagreeing.
                if (room !== null) room.setDial(id, v);
                else d.set(scene, v);
                setVals((p) => p.map((x, j) => (j === i ? v : x)));
              }}
            />
            {d.hint && <em>{d.hint}</em>}
          </label>
        );
      })}
    </>
  );
}

/**
 * MEMOISED. The HUD publishes fly state every 0.15 s and a perf sample every 0.5 s, so an
 * unmemoised panel reconciles twenty range inputs about seven times a second on telemetry
 * it does not read. `scene` only changes identity on a preset switch, on a room dial
 * packet, or when the admin gate changes.
 */
export const WeatherDebug = memo(function WeatherDebug({
  scene,
}: WeatherDebugProps): React.ReactElement | null {
  if (!scene) return null;
  // The room owns the weather when there is one, so a local switch is refused; and
  // whether the dials may be moved is on that object. Both DERIVED here rather than
  // published as separate flags — they are the same fact told three ways.
  const room = scene.roomDials;

  return (
    <CollapsiblePanel id="weatherdebug" title="Weather (live)">
      <div className="btns">
        {WEATHER_PRESET_IDS.map((id) => (
          <button
            key={id}
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
      <Group key={`a${scene.preset.id}`} title="Atmosphere" ids={GROUPED.atmosphere} scene={scene} />
      <Group
        key={`p${scene.preset.id}`}
        title="Precipitation"
        ids={GROUPED.precipitation}
        scene={scene}
      />
      {scene.blades && (
        <Group key={`b${scene.preset.id}`} title="Blades" ids={GROUPED.blades} scene={scene} />
      )}

      <p className="note">
        Switching a preset rewrites the grade, the fog and the rain in place — no material
        is rebuilt, so the terrain geometry cache survives and the comparison is honest.
        <br />
        Baked at load and still needing a reload: <code>?bladecount=</code>, which fixes
        the lattice the field radius divides up.
      </p>
    </CollapsiblePanel>
  );
});
