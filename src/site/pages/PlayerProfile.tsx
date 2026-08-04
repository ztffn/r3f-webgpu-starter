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
import {
  accuracy,
  describeStyle,
  formatMetres,
  formatRate,
  formatRatio,
  headshotRate,
  killDeathRatio,
  patienceScore,
  shotsPerKill,
  winRate,
} from "../../account/playerStats";
import { ribbonStyle } from "../ribbons";
import "./page.css";
import "./auth.css";
import "./community.css";
import "./dashboard.css";

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

  const { profile, clan, wall, activity, sessionsByDay, stats, viewer } = page;
  const style = describeStyle(stats);
  // The four figures a recruiter stops on. Range sits beside K/D deliberately:
  // the same K/D at 900 m and at 50 m describe two different players.
  const headline = [
    { label: "K/D", value: formatRatio(killDeathRatio(stats.combat)) },
    { label: "Median range", value: formatMetres(stats.medianRangeMetres) },
    { label: "Headshots", value: formatRate(headshotRate(stats.combat)) },
    { label: "Win rate", value: formatRate(winRate(stats.activity)) },
  ];
  const bandPeak = Math.max(...stats.ranges.map((band) => band.kills), 0);
  // One scale for the whole plot. Per-bar normalisation would make a quiet week
  // look identical to a busy one.
  const peak = Math.max(...sessionsByDay, 0);
  const earned = new Map(profile.medals.map((medal) => [medal.medalId, medal.awardedAt]));
  const problem = draft === "" ? null : validatePost(draft);

  const act = (kind: "post" | "friend" | "block", work: () => Promise<void>) =>
    void action.run(kind, async () => {
      await work();
      await load();
    });

  return (
    <>
      <header className="dash-head">
        <div className="shell dash-head-inner">
          <div>
            <p className="dash-eyebrow">
              {clan !== null ? (
                <Link to={`/clans/${clan.tag}`} className="clan-tag">
                  [{clan.tag}] {clan.name}
                </Link>
              ) : (
                "Unattached"
              )}
            </p>
            <h1 className="dash-name" data-dev="player-callsign">
              {profile.callsign}
            </h1>
            <div className="dash-badges">
              {profile.tier === "supporter" && (
                <span className="badge badge-accent">Supporter</span>
              )}
              {/* Only what this reader may actually do. A signed-out visitor sees
                  a profile with no buttons rather than buttons that 401. */}
              {!viewer.isSelf && viewer.canFriend && (
                <>
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
                      Requested
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
                      Accept request
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
                      Friends
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
                </>
              )}
            </div>
          </div>

          <dl className="dash-service" data-dev="player-service">
            <dt>Matches</dt>
            <dd>{fmt(profile.career.matches)}</dd>
            <dt>In the field</dt>
            <dd>
              {profile.career.timePlayedSeconds > 0
                ? duration(profile.career.timePlayedSeconds)
                : "—"}
            </dd>
            <dt>Ribbons</dt>
            <dd>{profile.medals.length}</dd>
            <dt>Clan</dt>
            <dd>{clan?.tag ?? "—"}</dd>
          </dl>
        </div>
      </header>

      {action.error !== null && (
        <div className="shell">
          <p className="field-error" role="alert" data-dev="player-error">
            {action.error}
          </p>
        </div>
      )}

      <div className="shell dash-body">
        <div className="dash-col">
          <section className="panel">
            <h2>Assessment</h2>
            {/* The verdict first, because it is the answer to the question the
                page is open for. It refuses to guess a role with no engagements
                rather than defaulting to the middle one. */}
            <p className="verdict" data-dev="player-verdict">
              {style.summary}
            </p>
            <div className="headline" data-dev="player-headline">
              {headline.map((figure) => (
                <div key={figure.label}>
                  <span className="headline-value">{figure.value}</span>
                  <span className="headline-label">{figure.label}</span>
                </div>
              ))}
            </div>
            {stats.available.engagements ? (
              <>
                <span className="kit-title" style={{ marginTop: "var(--s4)" }}>
                  Kills by range
                </span>
                <ul className="bands" data-dev="player-bands">
                  {stats.ranges.map((band) => (
                    <li key={band.label}>
                      <span className="band-label">{band.label}</span>
                      <span className="band-track">
                        <span
                          className="band-fill"
                          style={{
                            width: `${bandPeak === 0 ? 0 : (band.kills / bandPeak) * 100}%`,
                          }}
                        />
                      </span>
                      <span className="band-count">{band.kills}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              /* A frame with a reason, never zeroes. An empty range histogram
                 that looked populated would be a claim about how this player
                 fights, and nothing has measured it yet. */
              <p className="pending" data-dev="stats-pending">
                Range, headshots and accuracy need the combat authority work.
                Nothing records them yet.
              </p>
            )}
          </section>

          <section className="panel">
            <h2>Data on previous engagements</h2>
            <dl className="dope" data-dev="player-career">
              <dt>Longest shot</dt>
              <dd className="dope-hero">
                {profile.career.longestShotMetres > 0
                  ? `${fmt(Math.round(profile.career.longestShotMetres))} m`
                  : "—"}
              </dd>
              <dt>Matches</dt>
              <dd>{fmt(profile.career.matches)}</dd>
              <dt>Kills</dt>
              <dd>{fmt(profile.career.kills)}</dd>
              <dt>Deaths</dt>
              <dd>{fmt(profile.career.deaths)}</dd>
              <dt>Time in the field</dt>
              <dd>
                {profile.career.timePlayedSeconds > 0
                  ? duration(profile.career.timePlayedSeconds)
                  : "—"}
              </dd>
              <dt>Shots per kill</dt>
              <dd>{formatRatio(shotsPerKill(stats.combat))}</dd>
              <dt>Accuracy</dt>
              <dd>{formatRate(accuracy(stats.combat))}</dd>
              <dt>Patience</dt>
              <dd>
                {patienceScore(stats.activity) === null
                  ? "—"
                  : `${patienceScore(stats.activity)}/100`}
              </dd>
            </dl>
          </section>

          <section className="panel">
            <h2>Last 30 days</h2>
            {/* Real events, not a total: `sessions` records each finished match,
                and a day with none still draws a floor tick because the gaps are
                the shape of somebody's week. */}
            <div className="plot" data-dev="player-plot">
              {sessionsByDay.map((count, index) => (
                <span
                  key={index}
                  className="plot-bar"
                  data-value={count}
                  style={{ height: `${peak === 0 ? 0 : Math.round((count / peak) * 100)}%` }}
                  title={`${count} ${count === 1 ? "match" : "matches"}`}
                />
              ))}
            </div>
            <div className="plot-axis">
              <span>30 days ago</span>
              <span>Today</span>
            </div>
          </section>

          <section className="panel">
            <h2>Ribbons</h2>
            {profile.medals.length === 0 ? (
              <p className="rack-empty">None yet.</p>
            ) : (
              <ul className="rack" data-dev="player-medals">
                {MEDALS.filter((medal) => earned.has(medal.id)).map((medal, index) => (
                  <li
                    key={medal.id}
                    className="ribbon"
                    style={{ ...ribbonStyle(medal.id), animationDelay: `${index * 40}ms` }}
                    title={`${medal.name} — ${medal.description}`}
                    data-dev={`ribbon-${medal.id}`}
                  >
                    <span className="sr-only">{medal.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {activity.length > 0 && (
            <section className="panel">
              <h2>Activity</h2>
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

        <section className="panel">
          <h2>Wall</h2>

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
