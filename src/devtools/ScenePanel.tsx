// "Scene" tab — what loaded, and the view toggles that were the old HUD's controls.
//
// Terrain identity belongs here rather than on the game HUD for a reason beyond
// tidiness: the canopy-source warning is a claim about whether what you are
// looking at is real data, and docs/08 §8 invariant 5 says no grass result means
// anything without it. It needs to be somewhere a developer looks, not somewhere
// a player dismisses.

import { memo, useEffect, useState } from "react";
import {
  loadTerrainIndex,
  type LoadedTerrain,
  type TerrainIndexEntry,
} from "../df2/loadTerrain";
import type { Stance } from "../df2/FlyControls";
import type { SceneHandles } from "../df2/DF2Scene";
import {
  CALIBRATED_TERRAIN_SCALE,
  TERRAIN_SCALE_LIMITS,
  readMapSlug,
  type TerrainScale,
} from "../df2/config";
import { DialGroup, GROUPED } from "./dialGroup";
import { BENCH } from "../df2/bench";

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
  const [pending, setPending] = useState<{ key: "radius" | "spacing"; v: number } | null>(
    null
  );
  const [drag, setDrag] = useState<{ key: keyof TerrainScale; v: number } | null>(null);

  // The prepared-terrain list, for the map selector. Null until fetched (and
  // when no index ships, in which case the selector simply does not render).
  const [maps, setMaps] = useState<TerrainIndexEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    void loadTerrainIndex().then((entries) => {
      if (alive) setMaps(entries);
    });
    return () => {
      alive = false;
    };
  }, []);
  // What is on screen right now: the loaded map's slug, or (synthetic fallback)
  // whatever the URL asked for.
  const currentSlug =
    terrain?.slug ?? readMapSlug(typeof window === "undefined" ? "" : window.location.search);
  // A RELOAD, not runtime switching: the whole world — heightfield, chunks,
  // grass, motor terrain — is baked at load, same rule as the ?texel= seeds
  // (docs/01 Phase 1.6 tracks live map switching). Offline-only control, and
  // offline is always an explicit URL (a bare /play is networked by default),
  // so setting ?map= here cannot flip the launch mode — `map` is itself an
  // explicit launch parameter (launchParams.ts).
  const switchMap = (slug: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("map", slug);
    window.location.assign(url.toString());
  };

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

      {/* Networked, the room owns the map (the server names it in ROOM_INFO),
          so the selector renders offline only — like the scale dials below. */}
      {!networked && maps !== null && maps.length > 0 && (
        <label className="dial">
          <span className="dial-row">
            <span>Map</span>
          </span>
          <select
            data-dev="map-select"
            data-dev-value={currentSlug}
            aria-label="Map"
            value={maps.some((m) => m.slug === currentSlug) ? currentSlug : ""}
            onChange={(e) => {
              if (e.target.value !== "" && e.target.value !== currentSlug)
                switchMap(e.target.value);
            }}
          >
            {!maps.some((m) => m.slug === currentSlug) && (
              <option value="" disabled>
                {currentSlug} (not prepared)
              </option>
            )}
            {maps.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name === m.slug ? m.slug : `${m.name} (${m.slug})`}
              </option>
            ))}
          </select>
          <em>reloads with ?map= — the whole world is baked at load, like the scale seeds</em>
        </label>
      )}

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

      {scene && BENCH.foliage && (
        <>
          <span className="eyebrow dev-group">Foliage</span>
          {networked && BENCH.admin !== true ? (
            <p className="note" data-dev="foliage-locked">
              Density is hidden in a networked session. Cover is gameplay — growing
              yourself twice the bushes changes what you can hide behind, and nobody
              else would see it. Add <code>?admin=1</code> to unlock it locally, or go
              offline.
            </p>
          ) : (
            <label className="dial">
              <span className="dial-row">
                <span>Density</span>
                <b data-dev="readout-foliage-density">{scene.foliageDensity.toFixed(2)}</b>
              </span>
              <input
                type="range"
                data-dev="dial-foliage-density"
                data-dev-value={scene.foliageDensity}
                aria-label="Foliage density"
                min={0}
                max={10}
                step={0.25}
                value={scene.foliageDensity}
                // Live, unlike the scale dials: this clears the placement cache and the
                // renderer's budgeted refill rebuilds cells over the next few frames. No
                // mesh is rebuilt, so there is nothing to stall on and no second pipeline
                // warm-up.
                onChange={(e) => scene.setFoliageDensity(Number(e.target.value))}
              />
              <em>
                multiplies placement PROBABILITY, and SATURATES: a site yields at most one
                plant, so past ~3 it barely moves (measured: 4x gave 2.8x the plants). Site
                spacing below is the real lever on count. Live — no rebuild
                {networked ? " — and LOCAL, so no one else sees it" : ""}
              </em>
            </label>
          )}

          {/* REBUILD dials, so they commit on release. Radius changes how many buckets
              exist and spacing changes every bucket's buffer capacity, so either one
              reconstructs the cell window and re-runs the pipeline warm-up. Dragging
              those per tick would stall the drag. */}
          {(!networked || BENCH.admin === true) &&
            (
              [
                {
                  key: "radius" as const,
                  label: "Spawner reach",
                  min: 96,
                  max: 768,
                  step: 32,
                  value: scene.foliageRadius,
                  commit: scene.setFoliageRadius,
                  unit: "m",
                  hint: "how far plants are placed at all. Nothing is drawn past it, which is why a vista has a bare middle distance. Rebuilds",
                },
                {
                  key: "spacing" as const,
                  label: "Site spacing",
                  min: 1.5,
                  max: 8,
                  step: 0.25,
                  value: scene.foliageSpacing,
                  commit: scene.setFoliageSpacing,
                  unit: "m",
                  hint: "metres between candidate sites. Count scales as 1/spacing², so halving it quadruples the plants. 1.7 m is ~10x the default. Rebuilds",
                },
              ] as const
            ).map((d) => {
              const live = pending?.key === d.key ? pending.v : d.value;
              return (
                <label key={d.key} className="dial">
                  <span className="dial-row">
                    <span>{d.label}</span>
                    <b data-dev={`readout-foliage-${d.key}`}>
                      {live.toFixed(d.step < 1 ? 2 : 0)} {d.unit}
                    </b>
                  </span>
                  <input
                    type="range"
                    data-dev={`dial-foliage-${d.key}`}
                    data-dev-value={live}
                    aria-label={d.label}
                    min={d.min}
                    max={d.max}
                    step={d.step}
                    value={live}
                    onChange={(e) => setPending({ key: d.key, v: Number(e.target.value) })}
                    onPointerUp={() => {
                      if (pending?.key === d.key) d.commit(pending.v);
                      setPending(null);
                    }}
                    onKeyUp={() => {
                      if (pending?.key === d.key) d.commit(pending.v);
                      setPending(null);
                    }}
                    onBlur={() => setPending(null)}
                  />
                  <em>{d.hint}</em>
                </label>
              );
            })}
        </>
      )}

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
