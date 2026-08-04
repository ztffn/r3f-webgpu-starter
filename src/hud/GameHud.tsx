// The in-game HUD, rebuilt against design/df2-hud-1to1-html-v3 (authoritative).
//
// Every panel is driven by real data or says it has none. Two panels — objective
// and squad chat — have no system behind them at all, so they render only under
// `?hudpreview=1`: the mockup needs them present to be compared 1:1, and a player
// must never be shown a scripted objective that nothing will ever update.
//
// Layout is ANCHOR-based, not the mockup's fixed 1448x1086 scaled stage. See the
// design record §2.5: a transform-scaled stage letterboxes on a phone and scales
// hairlines into mush, and the touch layout has to move panels out of the thumb
// zones rather than shrink the desktop one.

import { useSyncExternalStore } from "react";
import { combatTelemetry } from "../fps/ui/CombatTelemetry";
import { HipfireCrosshair } from "../fps/ui/HipfireCrosshair";
import { impactTelemetryKey } from "../fps/ui/CombatTelemetry";
import type { FlyState } from "../df2/FlyControls";
import { Compass } from "./Compass";
import { RadarRose } from "./RadarRose";
import { InvitePanel } from "./InvitePanel";
import { VitalsPanel, type Vital } from "./VitalsPanel";
import { WeaponPanel } from "./WeaponPanel";
import "./hud.css";

export interface GameHudProps {
  fly: FlyState | null;
  /**
   * Local player health, 0–1, or null when nothing authoritative reports it.
   *
   * A PROP rather than something derived from `fly` here, because health is
   * server-owned and the authority work that publishes it is not finished. When it
   * lands, exactly one call site changes — this is the seam. Passing null is not a
   * placeholder for 100%: VitalsPanel renders an empty dashed track for it, which
   * is the honest reading when there is no damage model.
   */
  health: number | null;
  /**
   * The private room's invite code, or null.
   *
   * Passed in rather than read from a store because the HUD has no network
   * concept — GameApp is where the room and the HUD meet.
   */
  joinCode: string | null;
  /** True in the scope demo — the crosshair and weapon block only apply there. */
  fpsMode: boolean;
  /** `?hudpreview=1`: also render the panels that have no data source yet. */
  preview: boolean;
}

/** Compass bearing of the wind, from its component velocities. */
function windBearing(x: number, z: number): string {
  // Screen/world basis: -Z is north, +X is east. atan2(x, -z) gives the bearing
  // the wind blows TOWARDS, which is what a hold correction is read against.
  const degrees = ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round(degrees / 45) % 8]!;
}

export function GameHud({ fly, health, joinCode, fpsMode, preview }: GameHudProps) {
  const combat = useSyncExternalStore(
    combatTelemetry.subscribe,
    combatTelemetry.getSnapshot,
    combatTelemetry.getSnapshot
  );

  const net = fly?.net ?? null;
  // Stamina, hydration and armour are systems that do not exist. They render a
  // dashed empty track and a dash rather than a bar — see VitalsPanel for why
  // showing 100% armour with no armour system would be worse than showing nothing.
  const vitals: Record<Vital, number | null> = {
    health: health === null ? null : Math.max(0, Math.min(1, health)),
    stamina: null,
    hydration: null,
    armour: null,
  };

  const wind = combat.ballistics;
  const windSpeed =
    wind === null
      ? null
      : Math.hypot(wind.windXMetresPerSecond, wind.windZMetresPerSecond) * 3.6;

  return (
    <div className="hud-root skin-hud" data-dev="hud" data-dev-preview={preview || undefined}>
      {fpsMode && <HipfireCrosshair />}

      {combat.lastImpact && combat.lastImpact.damageApplied > 0 && (
        <div className="hit-marker" key={impactTelemetryKey(combat.lastImpact)}>
          {combat.lastImpact.destroyed ? "TARGET DOWN" : "HIT"}
        </div>
      )}

      <Compass />

      <InvitePanel joinCode={joinCode} />

      {/* Wind — real, from the ballistic environment the solver actually uses.
          The mockup pairs it with a "HOLD" row; nothing computes a hold yet, so
          that row is not invented here. */}
      {windSpeed !== null && (
        <section className="hud-panel hud-wind notched notched-sm" data-dev="hud-wind">
          <div className="hud-row">
            <span className="hud-label">
              <span className="hud-icon" aria-hidden="true">
                ≋
              </span>
              Wind
            </span>
            <span className="hud-value" data-dev="wind-value">
              <b className="hud-amber">
                {windBearing(wind!.windXMetresPerSecond, wind!.windZMetresPerSecond)}
              </b>
              &nbsp;&nbsp;{windSpeed.toFixed(0)} kph
            </span>
          </div>
        </section>
      )}

      {preview && (
        <>
          <section className="hud-panel hud-objective notched notched-sm" data-dev="hud-objective">
            <div className="hud-objective-title">Objective updated</div>
            <div className="hud-objective-body">Proceed to extraction point</div>
          </section>

          <section className="hud-panel hud-chat notched notched-sm" data-dev="hud-chat">
            <div>
              <span className="hud-team">[TEAM]</span> Viper: Eyes on tower
            </div>
            <div>
              <span className="hud-team">[TEAM]</span> Raven: Moving to ridge
            </div>
            <div>
              <span className="hud-lead">[LEAD]</span> Proceed to extraction point
            </div>
          </section>
        </>
      )}

      {fpsMode && (
        <WeaponPanel
          weaponId={(combat.weapon?.weaponId as never) ?? null}
          name={combat.weapon?.displayName ?? null}
          fireMode={combat.weapon?.fireMode ?? null}
          magazine={combat.weapon?.magazine ?? null}
          reserve={combat.weapon?.reserve ?? null}
        />
      )}

      <VitalsPanel values={vitals} />

      {/* Waypoints do not exist yet, so this panel reports what DOES: the range
          to whatever is under the aim point, and your own elevation. Both real. */}
      <section className="hud-panel hud-nav notched" data-dev="hud-nav">
        <div className="hud-nav-title">
          {net === null ? "Local" : `Player ${net.playerId}`}
        </div>
        <div className="hud-nav-k">Range</div>
        <div className="hud-nav-v" data-dev="nav-range">
          {combat.range ? `${combat.range.metres.toFixed(0)} m` : "—"}
        </div>
        <div className="hud-nav-k">Elev</div>
        <div className="hud-nav-v" data-dev="nav-elev">
          {fly ? `${fly.position.y.toFixed(0)} m` : "—"}
        </div>
        <RadarRose />
      </section>

      {/* There is no touch movement scheme yet (design record §2.5 schedules
          one), so a narrow screen is told rather than left to discover it. */}
      <p className="touch-note">Movement needs a keyboard — drag to look around.</p>
    </div>
  );
}
