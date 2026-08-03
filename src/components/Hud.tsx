// Instrument-panel HUD.
//
// Single deliberate dark theme: this sits over a live 3D scene, and a
// light-ground panel would wash out against sky. Monospace throughout because
// the content is survey/telemetry readouts, and tabular numerals so digits stop
// jittering as they update.

import { useSyncExternalStore } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import type { LoadedTerrain } from "../df2/loadTerrain";
import type { PerfSample } from "../df2/PerfMonitor";
import type { FlyState, Stance } from "../df2/FlyControls";
import {
  combatTelemetry,
  impactTelemetryKey,
  shotTelemetryKey,
} from "../fps/ui/CombatTelemetry";
import { HipfireCrosshair } from "../fps/ui/HipfireCrosshair";

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
      {fpsMode && <HipfireCrosshair />}
      {combat.lastImpact && combat.lastImpact.damageApplied > 0 && (
        <div className="hit-marker" key={impactTelemetryKey(combat.lastImpact)}>
          {combat.lastImpact.destroyed ? "TARGET DOWN" : "HIT"}
        </div>
      )}
      {combat.recentShots.length > 0 && (
        <CollapsiblePanel id="combat-log" title={<>Recent shots · {combat.lastShot?.mode}</>}>
          <ol className="shot-log">
            {combat.recentShots.map((shot) => {
              // The row's subject is the last damaged target, so every value
              // beside it must come from that target's own report — not from
              // shot totals or from a later terminal contact.
              const target = shot.target;
              const terminal = shot.terminal;
              const subject = target?.targetId ?? terminal?.surfaceId ?? terminal?.kind ?? "miss";
              const alsoDamaged =
                shot.damagedTargetCount > 1 ? ` · +${shot.damagedTargetCount - 1} more` : "";
              const detail = target
                ? `${fmt(target.rangeMetres, 1)} m · ${fmt(shot.flightTimeSeconds, 2)} s · ${fmt(target.damageApplied)} dmg · ${
                    target.destroyed ? "down" : `${fmt(target.healthAfter)} hp`
                  }${alsoDamaged}`
                : shot.hit
                  ? `${terminal?.penetrationOutcome ?? "impact"} · ${terminal?.ammunitionId ?? "—"} · ${shot.interactionCount} contact${shot.interactionCount === 1 ? "" : "s"}`
                  : `no impact · ${fmt(shot.flightTimeSeconds, 2)} s`;
              const status = target?.destroyed
                ? "down"
                : shot.totalDamageApplied > 0
                  ? "hit"
                  : undefined;
              return (
                <li key={shotTelemetryKey(shot)} className={status}>
                  <span>#{shot.sequence}</span>
                  <strong title={target?.objectName ?? terminal?.objectName}>{subject}</strong>
                  <em>{detail}</em>
                </li>
              );
            })}
          </ol>
        </CollapsiblePanel>
      )}
      {/* Terrain identity */}
      <CollapsiblePanel id="ident" title="Terrain">
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
      </CollapsiblePanel>

      {/* Telemetry */}
      <CollapsiblePanel id="telem" title="Position">
        <dl className="rows">
          <dt>East</dt>
          <dd>{fly ? fmt(fly.position.x) : "—"} m</dd>
          <dt>North</dt>
          <dd>{fly ? fmt(fly.position.z) : "—"} m</dd>
          <dt>Alt</dt>
          <dd>{fly ? fmt(fly.position.y) : "—"} m</dd>
          <dt>AGL</dt>
          <dd>{fly ? fmt(Math.max(0, fly.agl), 1) : "—"} m</dd>
          {fly?.net && (
            <>
              <dt>Net</dt>
              <dd>
                {fly.net.phase}
                {fly.net.playerId >= 0 ? ` · #${fly.net.playerId}` : ""}
              </dd>
            </>
          )}
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
              {combat.lastShot.terminal?.surfaceId && (
                <>
                  <dt>Terminal surface</dt>
                  <dd>
                    {combat.lastShot.terminal.surfaceId} ·{" "}
                    {combat.lastShot.terminal.penetrationOutcome}
                  </dd>
                  <dt>Thickness</dt>
                  <dd>
                    {combat.lastShot.terminal.effectiveThicknessMetres === null
                      ? "—"
                      : `${fmt(combat.lastShot.terminal.effectiveThicknessMetres * 100, 1)} cm`}
                  </dd>
                  <dt>Exit speed</dt>
                  <dd>
                    {combat.lastShot.terminal.retainedSpeedMetresPerSecond === null
                      ? "—"
                      : `${fmt(combat.lastShot.terminal.retainedSpeedMetresPerSecond)} m/s`}
                  </dd>
                </>
              )}
            </>
          )}
          {combat.lastImpact && (
            <>
              <dt>Last contact</dt>
              <dd>
                {combat.lastImpact.ammunitionId} · {combat.lastImpact.surfaceId} ·{" "}
                {combat.lastImpact.outcome}
              </dd>
              <dt>Contact speed</dt>
              <dd>
                {fmt(combat.lastImpact.speedBeforeMetresPerSecond)} →{" "}
                {fmt(combat.lastImpact.speedAfterMetresPerSecond)} m/s
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
              <dd>
                {combat.weapon.displayName} · {combat.weapon.fireMode.toUpperCase()} · PROXY MODEL
              </dd>
              <dt>Ammo</dt>
              <dd>
                {combat.weapon.magazine} / {combat.weapon.reserve}
              </dd>
              <dt>State</dt>
              <dd>{combat.weapon.phase}</dd>
            </>
          )}
          {combat.projectilePerformance && (
            <>
              <dt>Projectiles</dt>
              <dd>
                {combat.projectilePerformance.activeProjectiles} active ·{" "}
                {combat.projectilePerformance.peakActiveProjectiles} peak ·{" "}
                {combat.projectilePerformance.expiredProjectiles} expired
              </dd>
              {/* The timed span is the whole gameplay timeline, so the solver's
                  own cost is reported beside it rather than hidden inside it. */}
              <dt>Sim CPU</dt>
              <dd>
                {fmt(combat.projectilePerformance.simulationMillisecondsPerFrame, 2)} ms ·{" "}
                {fmt(combat.projectilePerformance.maxSimulationMilliseconds, 2)} peak
              </dd>
              <dt>Projectile CPU</dt>
              <dd>{fmt(combat.projectilePerformance.projectileMillisecondsPerFrame, 2)} ms</dd>
              <dt>Collision rate</dt>
              <dd>
                {fmt(combat.projectilePerformance.segmentQueriesPerSecond)} rays/s ·{" "}
                {fmt(combat.projectilePerformance.terrainCellTestsPerSecond)} cells/s
              </dd>
              <dt>Collider candidates</dt>
              <dd>{fmt(combat.projectilePerformance.colliderCandidatesPerSecond)}/s</dd>
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
      </CollapsiblePanel>

      {/* Controls */}
      <CollapsiblePanel id="ctl" title="View">
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
      </CollapsiblePanel>

      {/* Controls legend — collapsed by default: expanded, it sat on top of
          the combat telemetry column the moment the weapon HUD grew rows. */}
      <CollapsiblePanel id="legend" title="Controls" defaultOpen={false}>
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
          <dd>{fpsMode ? "sprint / ADS breath" : "boost ×4"}</dd>
          <dt>G</dt>
          <dd>foot / fly</dd>
          <dt>X C Z</dt>
          <dd>stand / crouch / prone</dd>
          {fpsMode && (
            <>
              <dt>1 / 2 / 3 / 4</dt>
              <dd>sniper / M4 / Glock / SAW</dd>
              <dt>B</dt>
              <dd>select fire mode</dd>
              <dt>Z / X (ADS)</dt>
              <dd>zoom in / out</dd>
              <dt>↑ ↓ (ADS)</dt>
              <dd>scope zero</dd>
              <dt>← → (ADS)</dt>
              <dd>windage ±0.1 mil</dd>
              <dt>0 (ADS)</dt>
              <dd>reset turrets</dd>
            </>
          )}
          <dt>Left click</dt>
          <dd>fire (scope demo)</dd>
          <dt>Right click</dt>
          <dd>scope aim</dd>
          <dt>R / T</dt>
          <dd>reload / reset targets</dd>
          {!fpsMode && (
            <>
              <dt>1–8</dt>
              <dd>weapon action (weaponanim=1)</dd>
            </>
          )}
        </dl>
      </CollapsiblePanel>
    </div>
  );
}
