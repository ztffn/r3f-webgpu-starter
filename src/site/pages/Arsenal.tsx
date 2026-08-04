// Weapons and maps: what the population actually fights with, and where.
//
// Two routes in one file because they are the same table with different columns
// and share every helper. Both are aggregates over `engagements` and
// `match_participation`, so both are empty until the authority layer writes
// them — and both say so rather than drawing a table of zeroes.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { accountClient, type MapRow, type WeaponRow } from "../../account/accountClient";
import { weaponLabel } from "../../account/characters";
import { formatMetres, formatRate, formatRatio } from "../../account/playerStats";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./dashboard.css";
import "./stats.css";

/** The frame-with-a-reason both pages show before telemetry exists. */
function Pending({ what }: { what: string }) {
  return (
    <p className="pending" data-dev="stats-pending">
      Nothing records {what} yet — it needs the server-authoritative combat work.
      The page is real; the rows are not being written.
    </p>
  );
}

export function Arsenal() {
  useDocumentTitle("Weapons");
  const [weapons, setWeapons] = useState<WeaponRow[] | null>(null);

  useEffect(() => {
    accountClient
      .statsWeapons()
      .then(setWeapons)
      .catch(() => setWeapons([]));
  }, []);

  const topKills = Math.max(...(weapons ?? []).map((row) => row.kills), 0);

  return (
    <>
      <header className="dash-head">
        <div className="shell dash-head-inner">
          <div>
            <p className="dash-eyebrow">Arsenal</p>
            <h1 className="dash-name">Weapons</h1>
          </div>
          <dl className="dash-service">
            <dt>In use</dt>
            <dd>{weapons?.length ?? "—"}</dd>
          </dl>
        </div>
      </header>

      <div className="shell page-body">
        {weapons === null ? (
          <p className="auth-note">Loading…</p>
        ) : weapons.length === 0 ? (
          <Pending what="which weapon fired a shot" />
        ) : (
          <div className="table-scroll">
            <table className="stat-table" data-dev="weapons">
              <thead>
                <tr>
                  <th>Weapon</th>
                  <th className="col-num">Kills</th>
                  <th className="col-bar">Share</th>
                  <th className="col-num">Shots</th>
                  <th className="col-num">Per kill</th>
                  <th className="col-num">HS</th>
                  <th className="col-num">Median range</th>
                  <th className="col-num">Users</th>
                </tr>
              </thead>
              <tbody>
                {weapons.map((row) => (
                  <tr key={row.weaponId} data-dev={`weapon-${row.weaponId}`}>
                    <td className="col-name strong">{weaponLabel(row.weaponId as never)}</td>
                    <td className="col-num">{row.kills.toLocaleString("en-US")}</td>
                    <td className="col-bar">
                      <span className="bar">
                        <span
                          className="bar-fill"
                          style={{ width: `${topKills === 0 ? 0 : (row.kills / topKills) * 100}%` }}
                        />
                      </span>
                      <span className="bar-value">{formatRate(row.share)}</span>
                    </td>
                    <td className="col-num quiet">{row.shots.toLocaleString("en-US")}</td>
                    <td className="col-num">{formatRatio(row.shotsPerKill)}</td>
                    <td className="col-num">{formatRate(row.headshotRate)}</td>
                    <td className="col-num accent">{formatMetres(row.medianRangeMetres)}</td>
                    <td className="col-num quiet">{row.users}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <Link className="btn btn-ghost btn-sm" to="/leaderboard">
            Standings
          </Link>
          <Link className="btn btn-ghost btn-sm" to="/maps">
            Maps
          </Link>
        </div>
      </div>
    </>
  );
}

export function Maps() {
  useDocumentTitle("Maps");
  const [maps, setMaps] = useState<MapRow[] | null>(null);

  useEffect(() => {
    accountClient
      .statsMaps()
      .then(setMaps)
      .catch(() => setMaps([]));
  }, []);

  return (
    <>
      <header className="dash-head">
        <div className="shell dash-head-inner">
          <div>
            <p className="dash-eyebrow">Terrain</p>
            <h1 className="dash-name">Maps</h1>
          </div>
          <dl className="dash-service">
            <dt>Played</dt>
            <dd>{maps?.length ?? "—"}</dd>
          </dl>
        </div>
      </header>

      <div className="shell page-body">
        {maps === null ? (
          <p className="auth-note">Loading…</p>
        ) : maps.length === 0 ? (
          <Pending what="which map a match was played on" />
        ) : (
          <div className="map-grid" data-dev="maps">
            {maps.map((row) => (
              <article className="map-card" key={row.map}>
                {/* The real colormap the game renders. A map card without the map
                    on it is a row of numbers pretending to be a place. */}
                <span
                  className="map-plate"
                  style={{ backgroundImage: `url(/assets/terrain/${row.map}/color.jpg)` }}
                  aria-hidden="true"
                />
                <div className="map-body">
                  <h2>{row.map}</h2>
                  <dl className="dope">
                    <dt>Matches</dt>
                    <dd>{row.matches}</dd>
                    <dt>Players</dt>
                    <dd>{row.players}</dd>
                    <dt>Median range</dt>
                    <dd className="accent">{formatMetres(row.medianRangeMetres)}</dd>
                    <dt>Average match</dt>
                    <dd>
                      {row.averageMatchMinutes === null
                        ? "—"
                        : `${Math.round(row.averageMatchMinutes)}m`}
                    </dd>
                    <dt>Time prone</dt>
                    <dd>{formatRate(row.proneShare)}</dd>
                  </dl>
                </div>
              </article>
            ))}
          </div>
        )}
        <div className="row">
          <Link className="btn btn-ghost btn-sm" to="/leaderboard">
            Standings
          </Link>
          <Link className="btn btn-ghost btn-sm" to="/weapons">
            Weapons
          </Link>
        </div>
      </div>
    </>
  );
}
