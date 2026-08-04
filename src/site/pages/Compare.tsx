// Two players, side by side.
//
// The page a clan recruiter opens after the profile: not "how good is this
// person" but "which of these two". Every row shows both figures and marks which
// side is ahead — a table of two columns nobody can scan is the failure here, so
// the winning cell is the one that is emphasised and the other is quiet.
//
// Rows whose figures are unknown for BOTH players are dropped rather than
// printed as two em dashes, because a comparison of two unknowns is noise.

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { accountClient, type ComparedPlayer } from "../../account/accountClient";
import {
  accuracy,
  describeStyle,
  formatMetres,
  formatRate,
  formatRatio,
  headshotRate,
  killDeathRatio,
  patienceScore,
  rankPoints,
  winRate,
  type PlayerStats,
} from "../../account/playerStats";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./dashboard.css";
import "./stats.css";

interface Row {
  label: string;
  /** Raw value, for deciding who is ahead. Null when unknown. */
  value: (stats: PlayerStats) => number | null;
  format: (stats: PlayerStats) => string;
  /** Almost every figure is better high. Deaths are not. */
  higherIsBetter?: boolean;
}

const ROWS: Row[] = [
  { label: "Rank points", value: (s) => rankPoints(s), format: (s) => rankPoints(s).toLocaleString("en-US") },
  { label: "Kills", value: (s) => s.combat.kills, format: (s) => s.combat.kills.toLocaleString("en-US") },
  { label: "Deaths", value: (s) => s.combat.deaths, format: (s) => s.combat.deaths.toLocaleString("en-US"), higherIsBetter: false },
  { label: "K/D", value: (s) => killDeathRatio(s.combat), format: (s) => formatRatio(killDeathRatio(s.combat)) },
  { label: "Win rate", value: (s) => winRate(s.activity), format: (s) => formatRate(winRate(s.activity)) },
  { label: "Median range", value: (s) => s.medianRangeMetres, format: (s) => formatMetres(s.medianRangeMetres) },
  { label: "Longest shot", value: (s) => s.combat.longestShotMetres, format: (s) => formatMetres(s.combat.longestShotMetres) },
  { label: "Headshots", value: (s) => headshotRate(s.combat), format: (s) => formatRate(headshotRate(s.combat)) },
  { label: "Accuracy", value: (s) => accuracy(s.combat), format: (s) => formatRate(accuracy(s.combat)) },
  { label: "Patience", value: (s) => patienceScore(s.activity), format: (s) => (patienceScore(s.activity) === null ? "—" : `${patienceScore(s.activity)}/100`) },
  { label: "Matches", value: (s) => s.activity.matches, format: (s) => s.activity.matches.toLocaleString("en-US") },
];

export function Compare() {
  useDocumentTitle("Compare");
  const [params, setParams] = useSearchParams();
  const [players, setPlayers] = useState<{ id: number; callsign: string }[]>([]);
  const [pair, setPair] = useState<{ a: ComparedPlayer; b: ComparedPlayer } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const a = params.get("a");
  const b = params.get("b");

  useEffect(() => {
    accountClient
      .statsPlayers()
      .then(setPlayers)
      .catch(() => setPlayers([]));
  }, []);

  useEffect(() => {
    if (a === null || b === null || a === b) {
      setPair(null);
      return;
    }
    setError(null);
    accountClient
      .compare(Number(a), Number(b))
      .then(setPair)
      .catch(() => setError("Could not load that comparison."));
  }, [a, b]);

  const pick = (side: "a" | "b", value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(side);
    else next.set(side, value);
    setParams(next, { replace: true });
  };

  return (
    <>
      <header className="dash-head">
        <div className="shell dash-head-inner">
          <div>
            <p className="dash-eyebrow">Head to head</p>
            <h1 className="dash-name">Compare</h1>
          </div>
        </div>
      </header>

      <div className="shell page-body">
        <div className="compare-pickers">
          {(["a", "b"] as const).map((side) => (
            <label className="field" key={side}>
              <span>{side === "a" ? "First player" : "Second player"}</span>
              <select
                value={params.get(side) ?? ""}
                data-dev={`pick-${side}`}
                onChange={(event) => pick(side, event.target.value)}
              >
                <option value="">Choose…</option>
                {players.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.callsign}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        {error !== null && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        {pair === null ? (
          <p className="auth-note" data-dev="compare-empty">
            Pick two players.
          </p>
        ) : (
          <>
            <div className="compare-heads">
              {[pair.a, pair.b].map((side, index) => (
                <div key={side.profile.id} className="compare-head">
                  <Link className="compare-name" to={`/players/${side.profile.id}`}>
                    {side.profile.callsign}
                  </Link>
                  <p className="verdict">{describeStyle(side.stats).summary}</p>
                  <span className="compare-side">{index === 0 ? "A" : "B"}</span>
                </div>
              ))}
            </div>

            <div className="table-scroll">
              <table className="stat-table compare-table" data-dev="compare">
                <tbody>
                  {ROWS.filter((row) => {
                    // Both unknown means the row says nothing. Drop it rather
                    // than printing two dashes and making the reader scan past.
                    return row.value(pair.a.stats) !== null || row.value(pair.b.stats) !== null;
                  }).map((row) => {
                    const left = row.value(pair.a.stats);
                    const right = row.value(pair.b.stats);
                    const better = row.higherIsBetter === false ? -1 : 1;
                    const leadA = left !== null && right !== null && (left - right) * better > 0;
                    const leadB = left !== null && right !== null && (right - left) * better > 0;
                    return (
                      <tr key={row.label}>
                        <td className={leadA ? "col-num lead" : "col-num quiet"}>
                          {row.format(pair.a.stats)}
                        </td>
                        <th className="compare-label">{row.label}</th>
                        <td className={leadB ? "col-num lead" : "col-num quiet"}>
                          {row.format(pair.b.stats)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
