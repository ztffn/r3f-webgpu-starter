// The board: one row per player, ranked on points, with the columns that let a
// reader re-rank by eye without another request.
//
// dfhub's shape, which is right for the job — rank insignia, callsign as the
// link, every numeric right-aligned in mono. One column is ours rather than
// theirs: MEDIAN RANGE, because it is the axis this game is about and it is the
// figure most likely to make somebody open a stranger's profile.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { accountClient, type LeaderboardEntry } from "../../account/accountClient";
import { formatMetres, formatRate, formatRatio } from "../../account/playerStats";
import { useAuth } from "../../account/AuthProvider";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./dashboard.css";
import "./stats.css";

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Sortable columns, and how each one reads. One table drives the whole page. */
const COLUMNS = [
  { key: "points", label: "Points", numeric: true },
  { key: "rating", label: "Rating", numeric: true },
  { key: "kills", label: "Kills", numeric: true },
  { key: "kd", label: "K/D", numeric: true },
  { key: "winRate", label: "Win", numeric: true },
  { key: "medianRangeMetres", label: "Range", numeric: true },
  { key: "timePlayedSeconds", label: "Time", numeric: true },
] as const;

type SortKey = (typeof COLUMNS)[number]["key"];

export function Standings() {
  useDocumentTitle("Standings");
  const { me } = useAuth();
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  // Three states, not two. Catching a failure into an empty array told the
  // visitor the game has no ranked players when the truth was that the server
  // could not be reached — the same "unknown rendered as a confident claim" the
  // pre-merge review called out, arriving through the error path.
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<SortKey>("points");

  useEffect(() => {
    accountClient
      .statsLeaderboard()
      .then(setEntries)
      .catch(() => setFailed(true));
  }, []);

  // Sorted in the browser, not by another request: the board is at most a couple
  // of hundred rows and a round trip per column click is the thing that stops
  // people exploring it.
  const rows = [...(entries ?? [])].sort((a, b) => {
    const left = a[sort];
    const right = b[sort];
    if (left === null) return 1;
    if (right === null) return -1;
    return Number(right) - Number(left);
  });

  return (
    <>
      <header className="dash-head">
        <div className="shell dash-head-inner">
          <div>
            <p className="dash-eyebrow">Standings</p>
            <h1 className="dash-name">The board</h1>
          </div>
          <dl className="dash-service">
            <dt>Ranked</dt>
            <dd>{entries?.length ?? "—"}</dd>
            <dt>Ranks on</dt>
            <dd>Points</dd>
          </dl>
        </div>
      </header>

      <div className="shell page-body">
        <p className="auth-note" style={{ maxWidth: "62ch" }}>
          Registered accounts only. Points weight winning and the range you shoot
          from above raw kills — the formula is in the design record, and it is
          meant to be argued with.
        </p>

        {failed ? (
          <p className="auth-note" data-dev="board-failed" role="alert">
            The board could not be loaded. Is the game server running?
          </p>
        ) : entries === null ? (
          <p className="auth-note">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="auth-note" data-dev="board-empty">
            Nobody ranked yet. Play a match and the board is yours.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="stat-table" data-dev="standings">
              <thead>
                <tr>
                  <th className="col-rank">#</th>
                  <th>Callsign</th>
                  {COLUMNS.map((column) => (
                    <th key={column.key} className="col-num">
                      <button
                        type="button"
                        className={sort === column.key ? "col-sort is-active" : "col-sort"}
                        data-dev={`sort-${column.key}`}
                        aria-pressed={sort === column.key}
                        onClick={() => setSort(column.key)}
                      >
                        {column.label}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((entry, index) => (
                  <tr
                    key={entry.id}
                    className={me?.account.id === entry.id ? "is-me" : undefined}
                    data-dev={`row-${entry.id}`}
                  >
                    <td className="col-rank">{index + 1}</td>
                    <td className="col-name">
                      {entry.clanTag !== null && (
                        <Link className="clan-tag" to={`/clans/${entry.clanTag}`}>
                          [{entry.clanTag}]
                        </Link>
                      )}
                      <Link to={`/players/${entry.id}`}>{entry.callsign}</Link>
                      {entry.tier === "supporter" && <span className="dot" title="Supporter" />}
                    </td>
                    <td className="col-num strong">{entry.points.toLocaleString("en-US")}</td>
                    <td className="col-num">
                      <span className="rating">
                        <span className="rating-fill" style={{ width: `${entry.rating}%` }} />
                        <span className="rating-value">{entry.rating}</span>
                      </span>
                    </td>
                    <td className="col-num">{entry.kills.toLocaleString("en-US")}</td>
                    <td className="col-num">{formatRatio(entry.kd)}</td>
                    <td className="col-num">{formatRate(entry.winRate)}</td>
                    <td className="col-num accent">{formatMetres(entry.medianRangeMetres)}</td>
                    <td className="col-num quiet">{duration(entry.timePlayedSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="row">
          <Link className="btn btn-ghost btn-sm" to="/weapons">
            Weapons
          </Link>
          <Link className="btn btn-ghost btn-sm" to="/maps">
            Maps
          </Link>
          <Link className="btn btn-ghost btn-sm" to="/compare">
            Compare two players
          </Link>
        </div>
      </div>
    </>
  );
}
