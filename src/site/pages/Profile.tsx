// Profile: identity, tier, career and medals, plus renaming and signing out.
//
// A guest gets the same page with an upgrade prompt where the career would be
// impressive — the point at which someone is looking at their own record is the
// right moment to offer keeping it. Gating reads `effectiveTier`, so a lapsed
// supporter sees the enlisted view without anything else having to know about
// expiry.

import { useState } from "react";
import { Link } from "react-router";
import { accountClient, AccountError } from "../../account/accountClient";
import { useAuth } from "../../account/AuthProvider";
import { validateCallsign } from "../../account/accountTypes";
import { MEDALS } from "../../account/medals";
import { tierById } from "../../account/tiers";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";

const fmt = (n: number) => n.toLocaleString("en-US");

const describeRename = (failure: unknown) =>
  failure instanceof AccountError ? failure.message : "Could not rename.";

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function Profile() {
  useDocumentTitle("Profile");
  const { me, loading, refresh, signOut } = useAuth();

  const [callsign, setCallsign] = useState("");
  const { busy, error, done: saved, run } = useAsyncAction<"rename">(describeRename);

  if (loading) {
    return (
      <div className="shell page-body">
        <p className="prose">Loading your record…</p>
      </div>
    );
  }

  if (me === null) {
    return (
      <div className="shell notfound">
        <p className="eyebrow">Not signed in</p>
        <h1 className="display display-lg">No record to show.</h1>
        <div className="row" style={{ justifyContent: "center" }}>
          <Link className="btn btn-primary" to="/sign-in">
            Sign in
          </Link>
          <Link className="btn btn-ghost" to="/play">
            Play as a guest
          </Link>
        </div>
      </div>
    );
  }

  const { account, career, medals, effectiveTier } = me;
  const tier = tierById(effectiveTier);
  // Id to award date, so the catalogue below can be rendered in ITS order rather
  // than in the order the awards happen to come back in.
  const awarded = new Map(medals.map((medal) => [medal.medalId, medal.awardedAt]));
  const lapsed = account.tier === "supporter" && effectiveTier !== "supporter";
  const problem = callsign === "" ? null : validateCallsign(callsign);

  const onRename = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (problem !== null) return;
    void run("rename", async () => {
      await accountClient.setCallsign(callsign);
      await refresh();
      setCallsign("");
    });
  };

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">{account.anonymous ? "Guest" : tier.name}</p>
          <h1 className="display display-lg" data-dev="profile-callsign">
            {account.callsign}
          </h1>
          <div className="row" style={{ marginTop: "var(--s4)" }}>
            <span className={`badge ${account.anonymous ? "" : "badge-accent"}`}>
              {account.anonymous ? "Not registered" : tier.name}
            </span>
            {lapsed && <span className="badge badge-bad">Supporter lapsed</span>}
            <span className="badge">Joined {account.createdAt.slice(0, 10)}</span>
          </div>
        </div>
      </header>

      <div className="shell page-body auth-page">
        {account.anonymous && (
          <section className="auth-card notched notched-sm tier-featured">
            <h2 className="display display-sm">This record is temporary</h2>
            <p className="auth-note">
              You are playing as a guest, so this account lives only in this
              browser. Registering keeps everything you see below and costs
              nothing.
            </p>
            <Link className="btn btn-primary" to="/register">
              Keep my progress
            </Link>
          </section>
        )}

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Career</h2>
          <dl className="rows" data-dev="profile-career">
            <dt>Matches</dt>
            <dd>{fmt(career.matches)}</dd>
            <dt>Kills</dt>
            <dd>{fmt(career.kills)}</dd>
            <dt>Deaths</dt>
            <dd>{fmt(career.deaths)}</dd>
            <dt>Longest shot</dt>
            <dd>{career.longestShotMetres > 0 ? `${fmt(Math.round(career.longestShotMetres))} m` : "—"}</dd>
            <dt>Time played</dt>
            <dd>{career.timePlayedSeconds > 0 ? duration(career.timePlayedSeconds) : "—"}</dd>
          </dl>
          {career.matches === 0 && (
            <p className="auth-note">
              Nothing recorded yet. Career statistics are written by the match
              server, which does not report them at this stage of development —
              so these will stay at zero for now rather than being invented.
            </p>
          )}
        </section>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Medals</h2>
          <p className="auth-note">
            Medals come only from play and cannot be bought — see the{" "}
            <Link to="/supporter">supporter page</Link> for where that line sits.
          </p>
          {/* The whole catalogue, not just what is held: a locked medal with its
              requirement beside it is something to go and do, whereas an empty
              list is indistinguishable from a feature that does not exist. */}
          <ul className="medal-list" data-dev="profile-medals">
            {MEDALS.map((medal) => {
              const held = awarded.get(medal.id);
              return (
                <li
                  key={medal.id}
                  className={held === undefined ? "medal-locked" : undefined}
                  data-dev={`medal-${medal.id}`}
                  data-dev-state={
                    held !== undefined ? "earned" : medal.earnable ? "locked" : "unearnable"
                  }
                >
                  <strong>{medal.name}</strong>
                  <span className="medal-note">
                    {held !== undefined
                      ? medal.description
                      : medal.earnable
                        ? medal.requirement
                        : // Not "you have not done this" — nothing records it yet,
                          // and the two are different claims.
                          `${medal.requirement} Nothing records this yet.`}
                  </span>
                  <em>{held !== undefined ? held.slice(0, 10) : "—"}</em>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Callsign</h2>
          <form className="stack" onSubmit={onRename}>
            <div className="field">
              <label htmlFor="newCallsign">New callsign</label>
              <input
                id="newCallsign"
                type="text"
                value={callsign}
                placeholder={account.callsign}
                data-dev="profile-rename-input"
                onChange={(event) => setCallsign(event.target.value)}
              />
              {problem !== null && <p className="field-error">{problem.message}</p>}
              {saved && problem === null && (
                <p className="field-hint" role="status">
                  Saved.
                </p>
              )}
            </div>
            {error !== null && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="btn"
              data-dev="profile-rename"
              disabled={busy !== null || callsign === "" || problem !== null}
            >
              {busy !== null ? "Saving…" : "Rename"}
            </button>
          </form>
        </section>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Session</h2>
          <div className="row">
            <Link className="btn btn-ghost" to="/character">
              Edit character
            </Link>
            <button
              type="button"
              className="btn btn-ghost"
              data-dev="profile-signout"
              onClick={signOut}
            >
              Sign out
            </button>
          </div>
          {account.anonymous && (
            <p className="auth-note">
              Signing out of a guest account cannot be undone — there is no
              password to sign back in with.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
