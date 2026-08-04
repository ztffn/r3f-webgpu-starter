// Leaderboards.
//
// The honest part is the empty state. Matches and time played are written when a
// session ends, so those boards fill up as soon as anyone plays. Kills and longest
// shot are not written by anything yet — they need the server-authoritative damage
// work — so the server marks those boards unpopulated and the page says which of
// the two reasons a table is blank. "Nobody has done this" and "nothing records
// this" look identical otherwise, and only one of them is true.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { accountClient } from "../../account/accountClient";
import type { BoardSummary, Leaderboard as Board } from "../../account/lobby";
import { useAuth } from "../../account/AuthProvider";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./lobby.css";

/** Boards whose numbers are metres or seconds need their own formatting. */
function formatValue(board: string, value: number): string {
  if (board === "distance") return `${Math.round(value)} m`;
  if (board === "time") {
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }
  return value.toLocaleString("en-US");
}

export function Leaderboard() {
  useDocumentTitle("Leaderboards");
  const { me } = useAuth();

  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [active, setActive] = useState<string>("matches");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which boards exist comes from the server, so adding one does not mean editing
  // this page.
  useEffect(() => {
    accountClient
      .leaderboards()
      .then(setBoards)
      .catch(() => setError("Could not load the boards."));
  }, []);

  useEffect(() => {
    setBoard(null);
    accountClient
      .leaderboard(active)
      .then(setBoard)
      .catch(() => setError("Could not load that board."));
  }, [active]);

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">Standings</p>
          <h1 className="display display-lg">Who has done what.</h1>
          <p className="prose" style={{ marginTop: "var(--s4)" }}>
            Registered accounts only. Guest accounts live in one browser and can be
            thrown away, so ranking them would reward clearing your storage.
          </p>
        </div>
      </header>

      <div className="shell page-body lobby-page">
        {error !== null && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <div className="btns row" role="tablist" aria-label="Leaderboards">
          {(boards ?? []).map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="btn btn-sm"
              data-dev={`board-${entry.id}`}
              aria-selected={active === entry.id}
              aria-pressed={active === entry.id}
              onClick={() => setActive(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <section className="auth-card notched notched-sm">
          {board === null ? (
            <p className="auth-note">Loading…</p>
          ) : board.rows.length === 0 ? (
            <p className="auth-note" data-dev="board-empty">
              {board.populated
                ? "Nobody has anything on this board yet. Play a match and you will be the first."
                : "Nothing records this statistic yet — it needs the server-authoritative combat work. The board is real; the numbers are not being written."}
            </p>
          ) : (
            <ol className="board" data-dev="board-rows">
              {board.rows.map((row) => {
                const isMe = me !== null && me.account.id === row.id;
                return (
                  <li key={row.id} className={isMe ? "board-me" : undefined}>
                    <span className="board-rank">{row.rank}</span>
                    <span className="board-name">
                      {row.callsign}
                      {row.tier === "supporter" && (
                        <span className="badge badge-accent">Supporter</span>
                      )}
                    </span>
                    <span className="board-value">{formatValue(board.board, row.value)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {(me === null || me.account.anonymous) && (
          <section className="auth-card notched notched-sm">
            <h2 className="display display-sm">Get on the board</h2>
            <p className="auth-note">
              A free account is all it takes, and registering keeps the progress you
              already have.
            </p>
            <Link className="btn btn-primary" to="/register">
              Register
            </Link>
          </section>
        )}
      </div>
    </>
  );
}
