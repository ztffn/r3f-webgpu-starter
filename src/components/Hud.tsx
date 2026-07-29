// Instrument-panel HUD.
//
// Single deliberate dark theme: this sits over a live 3D scene, and a
// light-ground panel would wash out against sky. Monospace throughout because
// the content is survey/telemetry readouts, and tabular numerals so digits stop
// jittering as they update.

import type { LoadedTerrain } from "../df2/loadTerrain";
import type { PerfSample } from "../df2/PerfMonitor";
import type { FlyState, Stance } from "../df2/FlyControls";

export interface HudProps {
  loading: boolean;
  terrain: LoadedTerrain | null;
  perf: PerfSample | null;
  fly: FlyState | null;
  grounded: boolean;
  setGrounded: (v: boolean) => void;
  stance: Stance;
  setStance: (s: Stance) => void;
  grass: boolean;
  setGrass: (v: boolean) => void;
  wireframe: boolean;
  setWireframe: (v: boolean) => void;
}

const fmt = (n: number, d = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export function Hud({
  loading,
  terrain,
  perf,
  fly,
  grounded,
  setGrounded,
  stance,
  setStance,
  grass,
  setGrass,
  wireframe,
  setWireframe,
}: HudProps) {
  if (loading) {
    return (
      <div className="boot">
        <div>Decoding terrain</div>
        <div className="bar">
          <i />
        </div>
      </div>
    );
  }

  const standIn = terrain?.grassSource === "colormap-standin";

  return (
    <div className="hud-root">
      {/* Terrain identity */}
      <section className="panel" id="ident">
        <span className="eyebrow">Terrain</span>
        <h1>{terrain ? terrain.name : "Synthetic fBm"}</h1>
        <div className="by">
          {terrain ? `${terrain.creator} · TerraNova EXP2b` : "no extracted assets found"}
        </div>
        <dl className="rows">
          {terrain && (
            <>
              <dt>Maps</dt>
              <dd>
                {terrain.size} × {terrain.size}
              </dd>
              <dt>Extent</dt>
              <dd>tiles infinitely</dd>
              <dt>Canopy</dt>
              <dd className={standIn ? "warn" : undefined}>
                {standIn ? "stand-in (not real)" : "extracted"}
              </dd>
            </>
          )}
          {!terrain && (
            <>
              <dt>Source</dt>
              <dd>procedural fallback</dd>
            </>
          )}
        </dl>
      </section>

      {/* Telemetry */}
      <section className="panel" id="telem">
        <span className="eyebrow">Position</span>
        <dl className="rows">
          <dt>East</dt>
          <dd>{fly ? fmt(fly.position.x) : "—"} m</dd>
          <dt>North</dt>
          <dd>{fly ? fmt(fly.position.z) : "—"} m</dd>
          <dt>Alt</dt>
          <dd>{fly ? fmt(fly.position.y) : "—"} m</dd>
          <dt>AGL</dt>
          <dd>{fly ? fmt(Math.max(0, fly.agl), 1) : "—"} m</dd>
        </dl>
        {perf && (
          <div className="perf">
            <span className="fps">{perf.fps.toFixed(0)} fps</span>
            <span>
              {perf.ms.toFixed(1)} ms · peak {perf.worstMs.toFixed(0)}
            </span>
            <span>
              {perf.drawCalls} calls · {(perf.triangles / 1000).toFixed(0)}k tris
            </span>
            <span className={perf.backend === "WebGPU" ? undefined : "warn"}>
              {perf.backend}
            </span>
          </div>
        )}
      </section>

      {/* Controls */}
      <section className="panel" id="ctl">
        <span className="eyebrow">View</span>
        <div className="btns">
          {/* Stable label + press state, like the toggles beside it. A label
              that swaps between "Fly" and "On foot" reads as either the current
              mode or the action, and you can't tell which. */}
          <button aria-pressed={grounded} onClick={() => setGrounded(!grounded)}>
            On foot
          </button>
          <button aria-pressed={grass} onClick={() => setGrass(!grass)}>
            Grass
          </button>
          <button aria-pressed={wireframe} onClick={() => setWireframe(!wireframe)}>
            Wire
          </button>
        </div>

        <span className="eyebrow" style={{ marginTop: 12 }}>
          Stance
        </span>
        <div className="btns">
          {(["stand", "crouch", "prone"] as Stance[]).map((s) => (
            <button
              key={s}
              // Not disabled while flying: picking a stance is how you say "put
              // me on the ground like this", so it drops you there.
              aria-pressed={grounded && stance === s}
              onClick={() => setStance(s)}
            >
              {s}
            </button>
          ))}
        </div>
        {standIn && (
          <p className="note">
            Canopy is derived from the colormap — the terrain's real grass data
            isn't in the expansion pack.
          </p>
        )}
        {/* Shown only on narrow screens (see styles.css): there is no touch
            movement scheme yet, and finding that out by poking at a static view
            is a worse first impression than being told. */}
        <p className="note touch-note">Movement needs a keyboard — drag to look around.</p>
      </section>

      {/* Controls legend */}
      <section className="panel" id="legend">
        <span className="eyebrow">Controls</span>
        <dl className="rows">
          <dt>Drag</dt>
          <dd>look</dd>
          <dt>W A S D</dt>
          <dd>move</dd>
          <dt>Q / E</dt>
          <dd>down / up</dd>
          <dt>Wheel</dt>
          <dd>fly speed</dd>
          <dt>Shift</dt>
          <dd>boost ×4</dd>
          <dt>G</dt>
          <dd>foot / fly</dd>
          <dt>X C Z</dt>
          <dd>stand / crouch / prone</dd>
        </dl>
      </section>
    </div>
  );
}
