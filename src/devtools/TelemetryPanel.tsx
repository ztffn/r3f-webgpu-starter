// "Telemetry" tab — position, frame cost, ballistics readouts and the shot log.
//
// Lifted wholesale out of the old HUD, which is where all of this used to live on
// top of the game. The content is unchanged on purpose: these rows are how the
// ballistics and networking work gets verified, and rewording them would break the
// correspondence with docs/10 and docs/11.

import type { PerfSample } from "../df2/PerfMonitor";
import { memo } from "react";
import { BUCKET_EDGES_MS, type FrameStatsReport } from "../df2/frameStats";
import type { FlyState } from "../df2/FlyControls";
import type { CombatSnapshot } from "../fps/ui/CombatTelemetry";
import { impactTelemetryKey, shotTelemetryKey } from "../fps/ui/CombatTelemetry";

export interface TelemetryPanelProps {
  perf: PerfSample | null;
  fly: FlyState | null;
  combat: CombatSnapshot;
}

const fmt = (n: number, d = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * The frame-time distribution rows.
 *
 * ITS OWN MEMOISED COMPONENT for two reasons. The panel re-renders whenever the fly state
 * ticks (~6.7 Hz) while `perf` only changes on its 500 ms report, so without this the
 * histogram map and the buckets join ran on unchanged data two renders out of three. And
 * `frames` is optional — a hot reload pairs a new panel with the last sample the OLD
 * monitor emitted, which has no distribution on it, and that combination threw into the
 * router's error boundary and cost a blank screen until a full reload. Taking it as a
 * required prop puts the check in one place and lets the types narrow.
 */
const FrameDistribution = memo(function FrameDistribution({
  frames,
}: {
  frames: FrameStatsReport;
}) {
  return (
    <>
      <span data-dev="perf-percentiles">
        p50 {frames.p50Ms.toFixed(1)} · p99 {frames.p99Ms.toFixed(1)} · max{" "}
        {frames.worstEverMs.toFixed(0)} ms
      </span>
      <span
        className={frames.hitches > 0 ? "warn" : undefined}
        data-dev="perf-hitches"
        data-dev-value={String(frames.hitches)}
      >
        {frames.hitches} hitch · {frames.stalls} stall · {frames.pauses} pause /{" "}
        {frames.frames} frames
      </span>
      <span data-dev="perf-histogram" data-dev-value={frames.buckets.join(",")}>
        {BUCKET_EDGES_MS.map((edge, i) =>
          frames.buckets[i] > 0 ? (
            <span key={edge} className="bucket">
              {Number.isFinite(edge) ? `<${edge.toFixed(0)}` : "1s+"}:{frames.buckets[i]}{" "}
            </span>
          ) : null
        )}
      </span>
    </>
  );
});

export function TelemetryPanel({ perf, fly, combat }: TelemetryPanelProps) {
  return (
    <>
      {perf && (
        <div className="perf" data-dev="perf" data-dev-value={perf.fps.toFixed(0)}>
          <span className="fps">{perf.fps.toFixed(0)} fps</span>
          <span>
            {perf.ms.toFixed(1)} ms · peak {perf.worstMs.toFixed(0)}
          </span>
          {/* The mean above is the number that read "no cost" while the camera visibly
              snagged. p99 and worst-since-load do not reset, so a hitch that happened
              once is still on screen a minute later. */}
          {perf.frames && <FrameDistribution frames={perf.frames} />}
          <span>
            {perf.drawCalls} calls · {(perf.triangles / 1000).toFixed(0)}k tris
            {perf.gpuMs != null && ` · gpu ${perf.gpuMs.toFixed(2)} ms`}
          </span>
          <span className={perf.backend === "WebGPU" ? undefined : "warn"}>
            {perf.backend}
          </span>
        </div>
      )}

      <span className="eyebrow dev-group">Position</span>
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
            <dd data-dev="net-phase">
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
            {/* The timed span is the whole gameplay timeline, so the solver's own
                cost is reported beside it rather than hidden inside it. */}
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

      {combat.recentShots.length > 0 && (
        <>
          <span className="eyebrow dev-group">
            Recent shots{combat.lastShot ? ` · ${combat.lastShot.mode}` : ""}
          </span>
          <ol className="shot-log" data-dev="shot-log">
            {combat.recentShots.map((shot) => {
              // The row's subject is the last damaged target, so every value beside
              // it must come from that target's own report — not from shot totals
              // or from a later terminal contact.
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
        </>
      )}

      {combat.lastImpact && (
        <span className="sr-only" data-dev="last-impact-key">
          {impactTelemetryKey(combat.lastImpact)}
        </span>
      )}
    </>
  );
}
