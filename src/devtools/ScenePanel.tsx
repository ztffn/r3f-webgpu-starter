// "Scene" tab — what loaded, and the view toggles that were the old HUD's controls.
//
// Terrain identity belongs here rather than on the game HUD for a reason beyond
// tidiness: the canopy-source warning is a claim about whether what you are
// looking at is real data, and docs/08 §8 invariant 5 says no grass result means
// anything without it. It needs to be somewhere a developer looks, not somewhere
// a player dismisses.

import type { LoadedTerrain } from "../df2/loadTerrain";
import type { Stance } from "../df2/FlyControls";

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
}

export function ScenePanel({
  terrain,
  grounded,
  setGrounded,
  stance,
  setStance,
  grass,
  setGrass,
  wireframe,
  setWireframe,
}: ScenePanelProps) {
  const standIn = terrain?.grassSource === "colormap-standin";

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

      {standIn && (
        <p className="note">
          Canopy is derived from the colormap — the terrain's real grass data is not
          in the expansion pack, so any claim about grass placement measured here is
          a claim about a stand-in.
        </p>
      )}
    </>
  );
}
