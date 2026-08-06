// The shared visual-dial UI: one slider group, live-writing offline and
// room-asking networked, plus the group->ids index over the wire table.
// Homed here rather than in a tab: WeatherPanel (atmosphere/precipitation/
// blades) and ScenePanel (ground detail) both render these groups, and dial
// markup carries the data-dev driver contract, which must exist exactly once.

import { useEffect, useRef, useState } from "react";
import type { SceneHandles } from "../df2/DF2Scene";
import { VISUAL_DIALS, type VisualDialGroup } from "../df2/visualDials";
import type { RoomVisuals } from "../fps/useRoomVisuals";

/** Dial ids by group, resolved once. Ids are indices into the shared table.
 * Exported with DialGroup: the terrain group renders on the Scene tab —
 * ground detail is not weather — but stays one wire table. */
export const GROUPED: Record<VisualDialGroup, number[]> = {
  atmosphere: [],
  precipitation: [],
  blades: [],
  terrain: [],
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

export function DialGroup({
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
      <span className="eyebrow dev-group">{title}</span>
      {ids.map((id, i) => {
        const d = VISUAL_DIALS[id]!;
        return (
          <label key={d.label} className="dial">
            <span className="dial-row">
              <span>{d.label}</span>
              <b data-dev={`readout-${id}`}>{vals[i]?.toFixed(d.step < 0.01 ? 3 : 2)}</b>
            </span>
            <input
              type="range"
              // Keyed on the dial's index in VISUAL_DIALS, which is also its wire
              // identity — so a driver, this panel and the server all name it the
              // same way. `data-dev-locked` says WHY a dial is inert, which the
              // `disabled` attribute on its own cannot.
              data-dev={`dial-${id}`}
              data-dev-value={vals[i] ?? d.min}
              data-dev-locked={room !== null && !room.dialsAllowed ? "not-admin" : undefined}
              aria-label={d.label}
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
