// Lobby: quick match, the server browser, join by code, and hosting a private game.
//
// One page rather than a lobby and a separate browser, because they are the same
// decision — "where am I playing" — and splitting them means two clicks to see the
// alternative. Quick match is first and needs no choices.
//
// Nothing here joins a room itself. Every route into a match is a navigation to
// /play with the parameters already set, so the game module stays unaware that a
// lobby exists and every dev URL keeps working unchanged.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { accountClient, AccountError } from "../../account/accountClient";
import { normaliseJoinCode, type ServerListing } from "../../account/lobby";
import { useAuth } from "../../account/AuthProvider";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./lobby.css";

/** How often the browser refreshes itself, milliseconds. */
const POLL_MS = 5000;

/**
 * The status is the message here, not the server's wording: "no such game" and
 * "that game is full" are different situations for the person typing a code, and
 * only one of them is worth retyping the code over.
 */
const describeJoin = (failure: unknown) => {
  if (failure instanceof AccountError && failure.status === 404) return "No game with that code.";
  if (failure instanceof AccountError && failure.status === 409) return "That game is full.";
  return "Could not join.";
};

export function Lobby() {
  useDocumentTitle("Play");
  const { can } = useAuth();
  const navigate = useNavigate();

  const [servers, setServers] = useState<ServerListing[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Prefilled from `?code=`, which is what a copied invite link carries. The field
  // stays editable — a link that silently auto-joined would give someone no chance
  // to notice they had opened the wrong one.
  const [params] = useSearchParams();
  const [code, setCode] = useState(() => normaliseJoinCode(params.get("code") ?? ""));
  const { busy, error: codeError, run } = useAsyncAction<"join">(describeJoin);

  const refresh = useCallback(async () => {
    try {
      setServers(await accountClient.servers());
      setListError(null);
    } catch (problem) {
      // A matchmaker that is down must not render as "no servers" — that reads as
      // nobody playing, and someone would wait rather than retry.
      setListError(
        problem instanceof AccountError && problem.status === 503
          ? "Cannot reach the match server. Is it running?"
          : "Could not load the server list."
      );
      setServers([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Skipped while the tab is hidden, and refreshed once on becoming visible. A
    // backgrounded tab parked here was making 720 matchmaker queries an hour to
    // update a list nobody was looking at.
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const onJoinCode = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run("join", async () => {
      // Resolved here, then navigated with the room id — so the code itself never
      // lands in browser history or in a URL someone might share later.
      const roomId = await accountClient.resolveJoinCode(code);
      navigate(`/play?scene=scope&motor=1&net=1&room=${encodeURIComponent(roomId)}`);
    });
  };

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">Deploy</p>
          <h1 className="display display-lg">Pick your ground.</h1>
        </div>
      </header>

      <div className="shell page-body lobby-page">
        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Quick match</h2>
          <p className="auth-note">
            Straight into a public game — the server picks the map and the weather,
            because fog is concealment and a match cannot let players choose it.
          </p>
          <Link className="btn btn-primary" to="/play?scene=scope&motor=1&net=1">
            Deploy now
          </Link>
        </section>

        <section className="auth-card notched notched-sm">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 className="display display-sm">Servers</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>

          {servers === null ? (
            <p className="auth-note">Looking for games…</p>
          ) : listError !== null ? (
            <p className="field-error" role="alert" data-dev="server-list-error">
              {listError}
            </p>
          ) : servers.length === 0 ? (
            <p className="auth-note" data-dev="server-list-empty">
              No public games running. Quick match above will start one.
            </p>
          ) : (
            <ul className="server-list" data-dev="server-list">
              {servers.map((server) => (
                <li key={server.roomId}>
                  <div className="server-main">
                    <strong>{server.label}</strong>
                    <span className="server-meta">
                      {server.map} · {server.weather} · {server.inputClass}
                      {server.community && server.hostCallsign !== null
                        ? ` · hosted by ${server.hostCallsign}`
                        : ""}
                    </span>
                  </div>
                  <span className="server-count">
                    {server.players}/{server.maxPlayers}
                  </span>
                  {server.locked || server.players >= server.maxPlayers ? (
                    <span className="badge">Full</span>
                  ) : (
                    <Link
                      className="btn btn-sm"
                      data-dev={`join-${server.roomId}`}
                      to={`/play?scene=scope&motor=1&net=1&room=${encodeURIComponent(server.roomId)}`}
                    >
                      Join
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Private game</h2>
          {/* The CAPABILITY, not an anonymous check: `joinPrivateGame` is what the
              supporter page advertises, so gating on anything else lets the two
              diverge silently. */}
          {!can("joinPrivateGame") ? (
            <p className="auth-note">
              Joining a private game needs an account.{" "}
              <Link to="/register">Register</Link> — it is free and keeps the
              progress you already have.
            </p>
          ) : (
            <form className="stack" onSubmit={onJoinCode}>
              <div className="field">
                <label htmlFor="code">Invite code</label>
                <input
                  id="code"
                  type="text"
                  inputMode="text"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={8}
                  value={code}
                  data-dev="join-code-input"
                  onChange={(event) => setCode(normaliseJoinCode(event.target.value))}
                />
                <p className="field-hint">
                  Six characters. Ambiguous letters and digits are never used, so
                  there is no O/0 or I/1 to guess at.
                </p>
                {codeError !== null && (
                  <p className="field-error" role="alert">
                    {codeError}
                  </p>
                )}
              </div>
              <button
                type="submit"
                className="btn"
                data-dev="join-code-submit"
                disabled={busy !== null || code.length < 4}
              >
                {busy !== null ? "Joining…" : "Join private game"}
              </button>
            </form>
          )}

          <span className="eyebrow">Host one</span>
          {can("hostPrivateGame") ? (
            <>
              <p className="auth-note">
                Starts an unlisted game that only people with its code can join.
                The code appears in the HUD once you are in, with a button to copy
                it or a link to send.
              </p>
              <Link
                className="btn btn-ghost"
                data-dev="host-private"
                to="/play?scene=scope&motor=1&net=1&private=1"
              >
                Host a private game
              </Link>
            </>
          ) : (
            <p className="auth-note">
              Hosting a private game is a{" "}
              <Link to="/supporter">supporter perk</Link>. Anyone with the code can
              join one.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
