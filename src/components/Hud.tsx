// Instrument-panel HUD.
//
// Single deliberate dark theme: this sits over a live 3D scene, and a
// light-ground panel would wash out against sky. Monospace throughout because
// the content is survey/telemetry readouts, and tabular numerals so digits stop
// jittering as they update.

import { useSyncExternalStore } from "react";
import type { LoadedTerrain } from "../df2/loadTerrain";
import type { PerfSample } from "../df2/PerfMonitor";
import type { FlyState, Stance } from "../df2/FlyControls";
import { combatTelemetry } from "../fps/ui/CombatTelemetry";

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
  fpsMode?: boolean;
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
  fpsMode = false,
}: HudProps) {
  const combat = useSyncExternalStore(
    combatTelemetry.subscribe,
    combatTelemetry.getSnapshot,
    combatTelemetry.getSnapshot
  );

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
      {combat.lastShot?.hit && combat.lastShot.damage > 0 && (
        <div className="hit-marker" key={combat.lastShot.sequence}>
          {combat.lastShot.destroyed ? "TARGET DOWN" : "HIT"}
        </div>
      )}
      {combat.recentShots.length > 0 && (
        <section className="panel" id="combat-log">
          <span className="eyebrow">Recent shots · {combat.lastShot?.mode}</span>
          <ol className="shot-log">
            {combat.recentShots.map((shot) => {
              const subject = shot.targetId ?? shot.kind ?? "miss";
              const detail = shot.targetId
                ? `${shot.metres === null ? "—" : fmt(shot.metres, 1)} m · ${fmt(shot.flightTimeSeconds, 2)} s · ${fmt(shot.damage)} dmg · ${
                    shot.destroyed ? "down" : `${fmt(shot.healthAfter ?? 0)} hp`
                  }`
                : shot.hit
                  ? `${shot.metres === null ? "—" : fmt(shot.metres, 1)} m · ${fmt(shot.flightTimeSeconds, 2)} s`
                  : `no impact · ${fmt(shot.flightTimeSeconds, 2)} s`;
              const status = shot.destroyed ? "down" : shot.damage > 0 ? "hit" : undefined;
              return (
                <li key={shot.sequence} className={status}>
                  <span>#{shot.sequence}</span>
                  <strong title={shot.objectName ?? undefined}>{subject}</strong>
                  <em>{detail}</em>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {/* Terrain identity */}
      <section className="panel" id="ident">
        <span className="eyebrow">Terrain</span>
        <h1>{terrain ? terrain.name : "Synthetic fBm"}</h1>
        {/* Pack name comes from the manifest, not a literal: this panel claimed
            "TerraNova EXP2b" for whatever terrain happened to load, which is wrong
            for every TerrainPack map. */}
        <div className="by">
          {terrain
            ? [terrain.creator, terrain.meta.source].filter(Boolean).join(" · ")
            : "no extracted assets found"}
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
          <dt>Scope</dt>
          <dd>{combat.range ? fmt(combat.range.metres, 1) : "—"} m</dd>
          <dt>Hit</dt>
          <dd>{combat.range ? combat.range.kind : "—"}</dd>
          {combat.ballistics && (
            <>
              <dt>Wind</dt>
              <dd>
                X {fmt(combat.ballistics.windXMetresPerSecond, 1)} · Z{" "}
                {fmt(combat.ballistics.windZMetresPerSecond, 1)} m/s
              </dd>
            </>
          )}
          {combat.lastShot?.mode === "ballistic" && (
            <>
              <dt>Flight</dt>
              <dd>{fmt(combat.lastShot.flightTimeSeconds, 3)} s</dd>
              <dt>Drop / drift</dt>
              <dd>
                {fmt(combat.lastShot.verticalDropMetres, 2)} /{" "}
                {fmt(combat.lastShot.lateralDriftMetres, 2)} m
              </dd>
              <dt>Impact speed</dt>
              <dd>
                {combat.lastShot.impactSpeedMetresPerSecond === null
                  ? "—"
                  : `${fmt(combat.lastShot.impactSpeedMetresPerSecond)} m/s`}
              </dd>
            </>
          )}
          {combat.aimResolution && (
            <>
              <dt>Aim step</dt>
              <dd>
                {fmt(combat.aimResolution.centimetresPerCount, 1)} cm /{" "}
                {fmt(combat.aimResolution.rangeMetres)} m
              </dd>
              <dt>Sway amp</dt>
              <dd>
                {fmt(combat.aimResolution.swayMetresAtRange, 2)} m /{" "}
                {fmt(combat.aimResolution.rangeMetres)} m
              </dd>
              <dt>Breath</dt>
              <dd>{fmt(combat.aimResolution.breathStabilization * 100)}%</dd>
            </>
          )}
          {combat.weapon && (
            <>
              <dt>Weapon</dt>
              <dd>{combat.weapon.displayName}</dd>
              <dt>Ammo</dt>
              <dd>
                {combat.weapon.magazine} / {combat.weapon.reserve}
              </dd>
              <dt>State</dt>
              <dd>{combat.weapon.phase}</dd>
            </>
          )}
          {combat.projectileRejectSequence > 0 && (
            <>
              <dt>Ballistic rejects</dt>
              <dd className="warn">{combat.projectileRejectSequence}</dd>
            </>
          )}
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
          <dt>{fpsMode ? "Mouse" : "Drag"}</dt>
          <dd>{fpsMode ? "click once, then look" : "look"}</dd>
          <dt>W A S D</dt>
          <dd>move</dd>
          <dt>Q / E</dt>
          <dd>down / up</dd>
          <dt>Wheel</dt>
          <dd>fly speed</dd>
          <dt>Shift</dt>
          <dd>{fpsMode ? "breath / precision" : "boost ×4"}</dd>
          <dt>G</dt>
          <dd>foot / fly</dd>
          <dt>X C Z</dt>
          <dd>stand / crouch / prone</dd>
          {fpsMode && (
            <>
              <dt>Z / X (ADS)</dt>
              <dd>zoom in / out</dd>
            </>
          )}
          <dt>Left click</dt>
          <dd>fire (scope demo)</dd>
          <dt>Right click</dt>
          <dd>scope aim</dd>
          <dt>R / T</dt>
          <dd>reload / reset targets</dd>
          <dt>1–8</dt>
          <dd>play weapon action</dd>
        </dl>
      </section>
    </div>
  );
}
