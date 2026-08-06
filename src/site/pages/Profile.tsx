// Profile: identity, tier, career and medals, plus renaming and signing out.
//
// A guest gets the same page with an upgrade prompt where the career would be
// impressive — the point at which someone is looking at their own record is the
// right moment to offer keeping it. Gating reads `effectiveTier`, so a lapsed
// supporter sees the enlisted view without anything else having to know about
// expiry.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { accountClient, AccountError } from "../../account/accountClient";
import { useAuth } from "../../account/AuthProvider";
import { validateCallsign } from "../../account/accountTypes";
import type { Friend } from "../../account/community";
import { MEDALS } from "../../account/medals";
import { tierById } from "../../account/tiers";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./community.css";

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
  const { busy, error, done: saved, run } = useAsyncAction<"rename" | "accept">(describeRename);
  const [social, setSocial] = useState<{ friends: Friend[]; incoming: Friend[] } | null>(null);

  // Loaded only for a registered account (see the effect), so a failure here is a
  // real failure rather than the guest case — reporting it as an empty roster
  // told the player nobody had added them when the request had not arrived.
  const [socialFailed, setSocialFailed] = useState(false);

  const loadFriends = useCallback(async () => {
    try {
      setSocial(await accountClient.friends());
      setSocialFailed(false);
    } catch {
      setSocialFailed(true);
    }
  }, []);

  useEffect(() => {
    if (me !== null && !me.account.anonymous) void loadFriends();
  }, [loadFriends, me]);

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
            <p className="auth-note">Nothing on the board yet. Go and deploy.</p>
          )}
        </section>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Medals</h2>
          <p className="auth-note">Earned in the field. Never for sale.</p>
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
                        : // Still honest — it says the medal is not being tracked
                          // rather than implying nobody has managed it — but in
                          // four words instead of a sentence about the roadmap.
                          "Not tracked yet."}
                  </span>
                  <em>{held !== undefined ? held.slice(0, 10) : "—"}</em>
                </li>
              );
            })}
          </ul>
        </section>

        {socialFailed && !account.anonymous && (
          <section className="auth-card notched notched-sm">
            <h2 className="display display-sm">Friends</h2>
            <p className="auth-note" role="alert" data-dev="friends-failed">
              Your friends list could not be loaded. Is the game server running?
            </p>
          </section>
        )}

        {social !== null && !account.anonymous && (
          <section className="auth-card notched notched-sm">
            <h2 className="display display-sm">Friends</h2>

            {social.incoming.length > 0 && (
              <>
                <span className="eyebrow">Waiting on you</span>
                <ul className="friend-list" data-dev="friend-requests">
                  {social.incoming.map((friend) => (
                    <li key={friend.id}>
                      <Link to={`/players/${friend.id}`}>{friend.callsign}</Link>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ marginLeft: "auto" }}
                        data-dev={`accept-${friend.id}`}
                        onClick={() => {
                          void run("accept", async () => {
                              await accountClient.acceptFriend(friend.id);
                              await loadFriends();
                            });
                        }}
                      >
                        Accept
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {social.friends.length === 0 ? (
              <p className="auth-note">
                Nobody yet. Open a name on the{" "}
                <Link to="/leaderboard">standings</Link> and add them.
              </p>
            ) : (
              <ul className="friend-list" data-dev="friend-list">
                {social.friends.map((friend) => (
                  <li key={friend.id}>
                    <Link to={`/players/${friend.id}`}>{friend.callsign}</Link>
                    {/* The one thing on this page that pulls somebody back into
                        a match. Presence is friends-only by design. */}
                    {friend.roomId !== undefined && (
                      <Link
                        className="friend-live"
                        data-dev={`friend-live-${friend.id}`}
                        to={`/play?scene=scope&motor=1&net=1&room=${encodeURIComponent(friend.roomId)}`}
                      >
                        In a game — join
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* A guest's callsign is generated and stays generated: `persistentName`
            is what registering buys, and the API refuses the rename either way
            (it used to not, which let an unregistered visitor claim any name
            permanently). Disabled with the reason beside it rather than hidden,
            so the perk is legible. */}
        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Callsign</h2>
          {account.anonymous ? (
            <p className="prose">
              You are playing as <strong>{account.callsign}</strong>.{" "}
              <Link to="/register">Register</Link> to choose your own — free, and you
              keep the career and medals you have already earned.
            </p>
          ) : (
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
          )}
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
