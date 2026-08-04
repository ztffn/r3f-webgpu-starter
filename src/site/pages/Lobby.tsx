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
import { Link, useNavigate } from "react-router";
import { accountClient, AccountError, type ServerListing } from "../../account/accountClient";
import { useAuth } from "../../account/AuthProvider";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./lobby.css";

/** How often the browser refreshes itself, milliseconds. */
const POLL_MS = 5000;

export function Lobby() {
  useDocumentTitle("Play");
  const { me, can } = useAuth();
  const navigate = useNavigate();

  const [servers, setServers] = useState<ServerListing[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const onJoinCode = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setCodeError(null);
    void (async () => {
      try {
        // Resolved here, then navigated with the room id — so the code itself never
        // lands in browser history or in a URL someone might share later.
        const roomId = await accountClient.resolveJoinCode(code);
        navigate(`/play?scene=scope&motor=1&net=1&room=${encodeURIComponent(roomId)}`);
      } catch (problem) {
        setCodeError(
          problem instanceof AccountError && problem.status === 404
            ? "No game with that code."
            : problem instanceof AccountError && problem.status === 409
              ? "That game is full."
              : "Could not join."
        );
      } finally {
        setBusy(false);
      }
    })();
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
          {me === null || me.account.anonymous ? (
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
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
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
                disabled={busy || code.trim().length < 4}
              >
                {busy ? "Joining…" : "Join private game"}
              </button>
            </form>
          )}

          <span className="eyebrow">Host one</span>
          {can("hostPrivateGame") ? (
            <>
              {/* Deliberately does NOT promise to show the code. The room mints one
                  and prints it to the server log, but nothing sends it to the host
                  yet — that needs a message on the game connection, which is not
                  built. Claiming otherwise would be the worst kind of copy: a
                  promise the UI cannot keep. Design record 5.4. */}
              <p className="auth-note">
                Starts an unlisted game that only people with its code can join.
              </p>
              <p className="field-hint">
                The code is not shown to you yet — it is printed in the server log.
                Surfacing it in-game is the next piece of this.
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
