// "Scene" tab — what loaded, and the view toggles that were the old HUD's controls.
//
// Terrain identity belongs here rather than on the game HUD for a reason beyond
// tidiness: the canopy-source warning is a claim about whether what you are
// looking at is real data, and docs/08 §8 invariant 5 says no grass result means
// anything without it. It needs to be somewhere a developer looks, not somewhere
// a player dismisses.

import { memo, useState } from "react";
import type { LoadedTerrain } from "../df2/loadTerrain";
import type { Stance } from "../df2/FlyControls";
import type { SceneHandles } from "../df2/DF2Scene";
import {
  CALIBRATED_TERRAIN_SCALE,
  TERRAIN_SCALE_LIMITS,
  type TerrainScale,
} from "../df2/config";
import { DialGroup, GROUPED } from "./dialGroup";

export interface ScenePanelProps {
  terrain: LoadedTerrain | null;
  grounded: boolean;
  setGrounded: (v: boolean) => void;
  stance: Stance;
  setStance: (s: Stance) => void;
  grass: boolean;
  setGrass: (v: boolean) => void;
  wireframe: boolean;
  setWireframe: (v: boolean) => void;
  terrainScale: TerrainScale;
  setTerrainScale: (s: TerrainScale) => void;
  /** Networked session — the scale dials hide, because the server owns the world. */
  networked: boolean;
  /** Dial handles for the ground-detail group; the dials live on the shared
   * visualDials wire but belong on this tab — ground detail is not weather. */
  scene: SceneHandles | null;
}

interface ScaleDial {
  key: keyof TerrainScale;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

// Calibration dials (docs runbook W1). Both scales are now calibrated, so these
// are A/B instruments rather than open questions — kept because the next map
// format or a disputed measurement wants them. Bounds come from
// TERRAIN_SCALE_LIMITS so the URL seeds clamp to exactly what these sliders allow.
const SCALE_DIALS: ScaleDial[] = [
  {
    key: "metersPerTexel",
    label: "Texel size",
    ...TERRAIN_SCALE_LIMITS.metersPerTexel,
    step: 0.05,
    hint: "metres per heightmap texel — calibrated 1.0 (map = 1.024 km)",
  },
  {
    key: "heightScale",
    label: "Height scale",
    ...TERRAIN_SCALE_LIMITS.heightScale,
    step: 0.05,
    hint: "metres per raw elevation unit — calibrated 0.5 (the editor manual's 1/2 m)",
  },
  {
    key: "smoothPasses",
    label: "Terrace smoothing",
    ...TERRAIN_SCALE_LIMITS.smoothPasses,
    step: 1,
    hint: "reconstruction passes; 0 shows the raw terraced data",
  },
];

/**
 * Memoised like its sibling tabs: the console re-renders at GameApp's telemetry
 * rate, and every prop here is identity-stable state or a useState setter, so
 * memo bails on all of those renders.
 */
export const ScenePanel = memo(function ScenePanel({
  terrain,
  grounded,
  setGrounded,
  stance,
  setStance,
  grass,
  setGrass,
  wireframe,
  setWireframe,
  terrainScale,
  setTerrainScale,
  networked,
  scene,
}: ScenePanelProps) {
  const standIn = terrain?.grassSource === "colormap-standin";
  // The one slider under the pointer during a drag (dragging is one dial at a
  // time by construction). Committing rebuilds the WHOLE world — heightfield,
  // chunk geometry, grass, motor terrain — so unlike the grass dials these
  // commit on release, and this mirror is what moves under the thumb.
  const [drag, setDrag] = useState<{ key: keyof TerrainScale; v: number } | null>(null);

  return (
    <>
      <span className="eyebrow dev-group">Terrain</span>
      <h2 className="dev-title" data-dev="terrain-name">
        {terrain ? terrain.name : "Synthetic fBm"}
      </h2>
      <div className="dev-by">
        {terrain
          ? [terrain.creator, terrain.meta.source].filter(Boolean).join(" · ")
          : "no extracted assets found"}
      </div>
      <dl className="rows">
        {terrain ? (
          <>
            <dt>Maps</dt>
            <dd>
              {terrain.size} × {terrain.size}
            </dd>
            <dt>Extent</dt>
            <dd>tiles infinitely</dd>
            <dt>Canopy</dt>
            <dd className={standIn ? "warn" : undefined} data-dev="canopy-source">
              {standIn ? "stand-in (not real)" : "extracted"}
            </dd>
          </>
        ) : (
          <>
            <dt>Source</dt>
            <dd data-dev="canopy-source">procedural fallback</dd>
          </>
        )}
      </dl>

      <span className="eyebrow dev-group">View</span>
      <div className="btns">
        {/* Stable label plus a press state, rather than a label that swaps between
            "Fly" and "On foot" — that reads as either the current mode or the
            action, and you cannot tell which. */}
        <button
          type="button"
          data-dev="toggle-grounded"
          aria-pressed={grounded}
          onClick={() => setGrounded(!grounded)}
        >
          On foot
        </button>
        <button
          type="button"
          data-dev="toggle-grass"
          aria-pressed={grass}
          onClick={() => setGrass(!grass)}
        >
          Grass
        </button>
        <button
          type="button"
          data-dev="toggle-wireframe"
          aria-pressed={wireframe}
          onClick={() => setWireframe(!wireframe)}
        >
          Wire
        </button>
      </div>

      <span className="eyebrow dev-group">Stance</span>
      <div className="btns" data-dev="stance" data-dev-value={grounded ? stance : "fly"}>
        {(["stand", "crouch", "prone"] as Stance[]).map((s) => (
          <button
            key={s}
            type="button"
            data-dev={`stance-${s}`}
            // Not disabled while flying: picking a stance is how you say "put me
            // on the ground like this", so it drops you there.
            aria-pressed={grounded && stance === s}
            onClick={() => setStance(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {terrain && (
        <>
          <span className="eyebrow dev-group">Scale</span>
          {networked ? (
            <p className="note" data-dev="scale-locked">
              Scale dials are hidden in a networked session: the server owns the
              world scale, and committing one here would rebuild the heightfield —
              which drops and rejoins the room. Go offline
              (<code>?scene=scope&amp;motor=1</code>) to calibrate.
            </p>
          ) : (
            <>
              {SCALE_DIALS.map((d) => {
            const live = drag?.key === d.key ? drag.v : terrainScale[d.key];
            const commit = () => {
              setDrag(null);
              if (drag?.key === d.key && drag.v !== terrainScale[d.key])
                setTerrainScale({ ...terrainScale, [d.key]: drag.v });
            };
            // Alt-tab mid-drag fires pointercancel, not pointerup — drop the
            // uncommitted value rather than leave a readout that looks live.
            const cancel = () => setDrag(null);
            return (
              <label key={d.key} className="dial">
                <span className="dial-row">
                  <span>{d.label}</span>
                  <b data-dev={`readout-${d.key}`}>
                    {live.toFixed(d.step < 1 ? 2 : 0)}
                  </b>
                </span>
                <input
                  type="range"
                  data-dev={`dial-${d.key}`}
                  data-dev-value={live}
                  aria-label={d.label}
                  min={d.min}
                  max={d.max}
                  step={d.step}
                  value={live}
                  onChange={(e) => setDrag({ key: d.key, v: Number(e.target.value) })}
                  // Committing rebuilds the world (~a second) — on release, not
                  // per tick, or the drag itself would stall the drag.
                  onPointerUp={commit}
                  onKeyUp={commit}
                  onBlur={commit}
                  onPointerCancel={cancel}
                />
                <em>{d.hint}</em>
              </label>
            );
          })}
          <div className="btns">
            <button
              type="button"
              data-dev="scale-reset"
              onClick={() => {
                setDrag(null);
                setTerrainScale(CALIBRATED_TERRAIN_SCALE);
              }}
            >
              Reset to calibrated
            </button>
          </div>
              <p className="note">
                Committing a scale rebuilds the whole world, so sliders apply on
                release. URL seeds: <code>?texel=</code> <code>?hscale=</code>{" "}
                <code>?hsmooth=</code>.
              </p>
            </>
          )}
        </>
      )}

      {scene?.terrainDetail && (
        <DialGroup title="Ground detail" ids={GROUPED.terrain} scene={scene} />
      )}

      {standIn && (
        <p className="note">
          Canopy is derived from the colormap — the terrain's real grass data is not
          in the expansion pack, so any claim about grass placement measured here is
          a claim about a stand-in.
        </p>
      )}
    </>
  );
});
