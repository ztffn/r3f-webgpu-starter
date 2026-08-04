// Another player's profile: their record on the left, their wall on the right.
//
// The hub of the community layer. Every callsign in the product links here, and
// this is the only page where one player can act on another — write on a wall,
// send a friend request, block. What a viewer may do is decided by the SERVER
// (`viewer` in the response) so the page never offers a button the endpoint
// would refuse.
//
// Modelled on the MapMakers Heaven member page: a profile is a place with an
// owner that other people leave things on, not a readout of someone's stats.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { accountClient, AccountError, type PlayerPage } from "../../account/accountClient";
import { POST_MAX, validatePost } from "../../account/community";
import { MEDALS } from "../../account/medals";
import { useAuth } from "../../account/AuthProvider";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./community.css";

const fmt = (n: number) => n.toLocaleString("en-US");

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** "3 days ago". Absolute dates are noise on a wall; recency is the signal. */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : iso.slice(0, 10);
}

const describeAction = (failure: unknown) => {
  if (!(failure instanceof AccountError)) return "That did not work.";
  if (failure.status === 429) return "Slow down — try again in a while.";
  if (failure.status === 403) return "You cannot do that here.";
  return failure.message;
};

export function PlayerProfile() {
  const { id } = useParams();
  const playerId = Number(id);
  const { me } = useAuth();

  const [page, setPage] = useState<PlayerPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState("");
  const action = useAsyncAction<"post" | "friend" | "block">(describeAction);

  useDocumentTitle(page?.profile.callsign ?? "Player");

  const load = useCallback(async () => {
    try {
      setPage(await accountClient.player(playerId));
    } catch {
      setMissing(true);
    }
  }, [playerId]);

  useEffect(() => {
    if (!Number.isInteger(playerId) || playerId <= 0) {
      setMissing(true);
      return;
    }
    void load();
    // Reloaded when the signed-in account changes, because `viewer` — which
    // decides every button on this page — is computed per reader.
  }, [load, playerId, me?.account.id]);

  if (missing) {
    return (
      <div className="shell notfound">
        <p className="eyebrow">Not found</p>
        <h1 className="display display-lg">No such player.</h1>
        <Link className="btn btn-ghost" to="/leaderboard">
          Back to the standings
        </Link>
      </div>
    );
  }

  if (page === null) {
    return (
      <div className="shell page-body">
        <p className="prose">Loading…</p>
      </div>
    );
  }

  const { profile, clan, wall, activity, viewer } = page;
  const earned = new Map(profile.medals.map((medal) => [medal.medalId, medal.awardedAt]));
  const problem = draft === "" ? null : validatePost(draft);

  const act = (kind: "post" | "friend" | "block", work: () => Promise<void>) =>
    void action.run(kind, async () => {
      await work();
      await load();
    });

  return (
    <>
      <header className="page-head">
        <div className="shell profile-head">
          <div>
            <p className="eyebrow">
              {clan !== null ? (
                <Link to={`/clans/${clan.tag}`} className="clan-tag">
                  [{clan.tag}]
                </Link>
              ) : (
                "Operator"
              )}
            </p>
            <h1 className="display display-lg" data-dev="player-callsign">
              {profile.callsign}
            </h1>
            {profile.tier === "supporter" && (
              <span className="badge badge-accent">Supporter</span>
            )}
          </div>

          {/* Only what this reader may actually do. A signed-out visitor sees a
              profile with no buttons rather than buttons that 401. */}
          {!viewer.isSelf && viewer.canFriend && (
            <div className="row profile-actions">
              {viewer.friendState === "none" && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-dev="friend-add"
                  disabled={action.busy !== null}
                  onClick={() =>
                    act("friend", async () => {
                      await accountClient.requestFriend(playerId);
                    })
                  }
                >
                  Add friend
                </button>
              )}
              {viewer.friendState === "pending_out" && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-dev="friend-withdraw"
                  disabled={action.busy !== null}
                  onClick={() => act("friend", () => accountClient.removeFriend(playerId))}
                >
                  Requested — withdraw
                </button>
              )}
              {viewer.friendState === "pending_in" && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-dev="friend-accept"
                  disabled={action.busy !== null}
                  onClick={() => act("friend", () => accountClient.acceptFriend(playerId))}
                >
                  Accept friend request
                </button>
              )}
              {viewer.friendState === "friends" && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-dev="friend-remove"
                  disabled={action.busy !== null}
                  onClick={() => act("friend", () => accountClient.removeFriend(playerId))}
                >
                  Friends — remove
                </button>
              )}
              {viewer.friendState === "blocked" ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-dev="unblock"
                  disabled={action.busy !== null}
                  onClick={() => act("block", () => accountClient.unblock(playerId))}
                >
                  Unblock
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-dev="block"
                  disabled={action.busy !== null}
                  onClick={() => act("block", () => accountClient.block(playerId))}
                >
                  Block
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {action.error !== null && (
        <div className="shell">
          <p className="field-error" role="alert" data-dev="player-error">
            {action.error}
          </p>
        </div>
      )}

      <div className="shell page-body profile-grid">
        <div className="stack">
          <section className="auth-card notched notched-sm">
            <h2 className="display display-sm">Record</h2>
            <dl className="rows" data-dev="player-career">
              <dt>Matches</dt>
              <dd>{fmt(profile.career.matches)}</dd>
              <dt>Kills</dt>
              <dd>{fmt(profile.career.kills)}</dd>
              <dt>Deaths</dt>
              <dd>{fmt(profile.career.deaths)}</dd>
              <dt>Longest shot</dt>
              <dd>
                {profile.career.longestShotMetres > 0
                  ? `${fmt(Math.round(profile.career.longestShotMetres))} m`
                  : "—"}
              </dd>
              <dt>Time played</dt>
              <dd>
                {profile.career.timePlayedSeconds > 0
                  ? duration(profile.career.timePlayedSeconds)
                  : "—"}
              </dd>
            </dl>
          </section>

          <section className="auth-card notched notched-sm">
            <h2 className="display display-sm">Medals</h2>
            {/* Someone ELSE's shelf shows what they hold, not what they have yet
                to earn — a stranger's locked list is a to-do list for a person
                who did not ask for one. */}
            {profile.medals.length === 0 ? (
              <p className="auth-note">None yet.</p>
            ) : (
              <ul className="medal-list" data-dev="player-medals">
                {MEDALS.filter((medal) => earned.has(medal.id)).map((medal) => (
                  <li key={medal.id}>
                    <strong>{medal.name}</strong>
                    <span className="medal-note">{medal.description}</span>
                    <em>{earned.get(medal.id)?.slice(0, 10)}</em>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {activity.length > 0 && (
            <section className="auth-card notched notched-sm">
              <h2 className="display display-sm">Activity</h2>
              <ul className="activity" data-dev="player-activity">
                {activity.map((entry) => (
                  <li key={`${entry.kind}-${entry.at}-${entry.text}`}>
                    <span>{entry.text}</span>
                    <em>{ago(entry.at)}</em>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Wall</h2>

          {viewer.canPost && viewer.friendState !== "blocked" ? (
            <form
              className="stack wall-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (problem !== null) return;
                act("post", async () => {
                  await accountClient.postToWall(playerId, draft);
                  setDraft("");
                });
              }}
            >
              <textarea
                rows={3}
                maxLength={POST_MAX}
                value={draft}
                placeholder={
                  viewer.isSelf ? "Say something on your own wall" : `Leave ${profile.callsign} a note`
                }
                data-dev="wall-input"
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="wall-form-foot">
                <span className="wall-count">
                  {draft.length}/{POST_MAX}
                </span>
                <button
                  type="submit"
                  className="btn btn-sm"
                  data-dev="wall-post"
                  disabled={action.busy !== null || draft.trim() === "" || problem !== null}
                >
                  {action.busy === "post" ? "Posting…" : "Post"}
                </button>
              </div>
            </form>
          ) : (
            <p className="auth-note">
              {viewer.id === null ? (
                <>
                  <Link to="/sign-in">Sign in</Link> to leave a note.
                </>
              ) : (
                "You cannot post here."
              )}
            </p>
          )}

          {wall.length === 0 ? (
            <p className="auth-note" data-dev="wall-empty">
              Nothing here yet.
            </p>
          ) : (
            <ul className="wall" data-dev="wall">
              {wall.map((post) => (
                <li key={post.id}>
                  <div className="wall-meta">
                    <Link to={`/players/${post.authorId}`}>{post.authorCallsign}</Link>
                    <em>{ago(post.createdAt)}</em>
                    {/* The wall's owner may remove anything on it, and an author
                        may remove their own note anywhere. */}
                    {(viewer.isSelf || viewer.id === post.authorId) && (
                      <button
                        type="button"
                        className="wall-delete"
                        aria-label="Delete this note"
                        data-dev={`wall-delete-${post.id}`}
                        onClick={() => act("post", () => accountClient.deletePost(post.id))}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {/* Plain text in a text node: React escapes it, and nothing
                      here ever renders markup (design record §3.2). */}
                  <p className="wall-body">{post.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
