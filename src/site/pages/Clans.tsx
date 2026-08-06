// Clans: the directory, one clan's roster, and founding one.
//
// Two routes in one file because they are one feature and share every type.
// Founding is gated on the `foundClan` supporter capability; JOINING is
// deliberately open to anyone — supporters get to run things, players get to do
// things, and a clan only supporters could join would be a paid team advantage.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { accountClient, AccountError } from "../../account/accountClient";
import {
  CLAN_TAG_MAX,
  CLAN_NAME_MAX,
  normaliseClanTag,
  validateClanName,
  validateClanTag,
  type Clan as ClanRecord,
  type ClanSummary,
} from "../../account/community";
import { useAuth } from "../../account/AuthProvider";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";
import "./community.css";

const describe = (failure: unknown) => {
  if (!(failure instanceof AccountError)) return "That did not work.";
  if (failure.status === 403) return "Founding a clan is a supporter perk.";
  return failure.message;
};

export function Clans() {
  useDocumentTitle("Clans");
  const { me, can } = useAuth();
  const [clans, setClans] = useState<ClanSummary[] | null>(null);
  // "Could not load" is not "none exist". Swallowing the failure into an empty
  // array told a visitor no clans had been founded whenever the server was down.
  const [failed, setFailed] = useState(false);
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const action = useAsyncAction<"found">(describe);

  const load = useCallback(async () => {
    try {
      setClans(await accountClient.clans());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const problem =
    tag === "" && name === "" ? null : (validateClanTag(tag) ?? validateClanName(name));

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">Units</p>
          <h1 className="display display-lg">Find your people.</h1>
        </div>
      </header>

      <div className="shell page-body auth-page">
        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Clans</h2>
          {failed ? (
            <p className="auth-note" data-dev="clans-failed" role="alert">
              The clan list could not be loaded. Is the game server running?
            </p>
          ) : clans === null ? (
            <p className="auth-note">Loading…</p>
          ) : clans.length === 0 ? (
            <p className="auth-note" data-dev="clans-empty">
              None yet. The first one is up for grabs.
            </p>
          ) : (
            <ul className="clan-list" data-dev="clan-list">
              {clans.map((clan) => (
                <li key={clan.id}>
                  <Link className="clan-tag" to={`/clans/${clan.tag}`}>
                    [{clan.tag}]
                  </Link>
                  <span className="clan-list-name">{clan.name}</span>
                  <span className="clan-list-count">{clan.memberCount}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {me !== null && (
          <section className="auth-card notched notched-sm">
            <h2 className="display display-sm">Found a clan</h2>
            {can("foundClan") ? (
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (problem !== null) return;
                  void action.run("found", async () => {
                    await accountClient.foundClan(tag, name);
                    setTag("");
                    setName("");
                    await load();
                  });
                }}
              >
                <div className="field">
                  <label htmlFor="clanTag">Tag</label>
                  <input
                    id="clanTag"
                    value={tag}
                    maxLength={CLAN_TAG_MAX}
                    autoComplete="off"
                    data-dev="clan-tag"
                    onChange={(event) => setTag(normaliseClanTag(event.target.value))}
                  />
                  <p className="field-hint">Worn beside every member’s name.</p>
                </div>
                <div className="field">
                  <label htmlFor="clanName">Name</label>
                  <input
                    id="clanName"
                    value={name}
                    maxLength={CLAN_NAME_MAX}
                    autoComplete="off"
                    data-dev="clan-name"
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                {problem !== null && <p className="field-error">{problem.message}</p>}
                {action.error !== null && (
                  <p className="field-error" role="alert">
                    {action.error}
                  </p>
                )}
                <button
                  type="submit"
                  className="btn btn-primary"
                  data-dev="clan-found"
                  disabled={action.busy !== null || tag === "" || name === "" || problem !== null}
                >
                  {action.busy !== null ? "Founding…" : "Found it"}
                </button>
              </form>
            ) : (
              <p className="auth-note">
                Founding is a <Link to="/supporter">supporter perk</Link>. Joining
                one is not.
              </p>
            )}
          </section>
        )}
      </div>
    </>
  );
}

export function ClanPage() {
  const { tag } = useParams();
  const { me, refresh } = useAuth();
  const [clan, setClan] = useState<ClanRecord | null>(null);
  /**
   * Three outcomes, like PlayerProfile: loading, gone, or unreachable.
   *
   * One `missing` flag conflated the last two — a network hiccup reported "no
   * such clan" for a clan that exists — and it was never RESET, so navigating
   * back to a good tag kept showing the not-found page until a full reload,
   * because ClanPage is reused across `/clans/:tag` changes.
   */
  const [status, setStatus] = useState<"loading" | "ok" | "missing" | "failed">("loading");
  const action = useAsyncAction<"join" | "leave" | "promote">(describe);
  useDocumentTitle(clan === null ? "Clan" : `[${clan.tag}] ${clan.name}`);

  const load = useCallback(async () => {
    setStatus("loading");
    setClan(null);
    try {
      setClan(await accountClient.clan(String(tag)));
      setStatus("ok");
    } catch (failure) {
      // 404 is "no such clan"; anything else is "could not ask".
      setStatus(failure instanceof AccountError && failure.status === 404 ? "missing" : "failed");
    }
  }, [tag]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "missing") {
    return (
      <div className="shell notfound">
        <p className="eyebrow">Not found</p>
        <h1 className="display display-lg">No such clan.</h1>
        <Link className="btn btn-ghost" to="/clans">
          All clans
        </Link>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="shell notfound">
        <p className="eyebrow">Unavailable</p>
        <h1 className="display display-lg">Could not load that clan.</h1>
        <p className="prose">Is the game server running?</p>
        <button className="btn btn-ghost" type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (clan === null) {
    return (
      <div className="shell page-body">
        <p className="prose">Loading…</p>
      </div>
    );
  }

  const mine = me !== null && clan.members.some((member) => member.id === me.account.id);
  const isLeader =
    me !== null &&
    clan.members.some((member) => member.id === me.account.id && member.role === "leader");

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow clan-tag">[{clan.tag}]</p>
          <h1 className="display display-lg">{clan.name}</h1>
          <div className="row" style={{ marginTop: "var(--s4)" }}>
            <span className="badge">
              {clan.memberCount} {clan.memberCount === 1 ? "member" : "members"}
            </span>
            <span className="badge">Founded {clan.createdAt.slice(0, 10)}</span>
          </div>
        </div>
      </header>

      <div className="shell page-body auth-page">
        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Roster</h2>
          <ul className="friend-list" data-dev="clan-roster">
            {clan.members.map((member) => (
              <li key={member.id}>
                <Link to={`/players/${member.id}`}>{member.callsign}</Link>
                <span className="clan-role">{member.role}</span>
                {/* Only a leader sees this, and only against someone else:
                    handing the clan on is how a leader stays in it and stops
                    being the one who cannot leave. */}
                {isLeader && member.id !== me?.account.id && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-dev={`clan-promote-${member.id}`}
                    disabled={action.busy !== null}
                    onClick={() =>
                      void action.run("promote", async () => {
                        await accountClient.promoteClanMember(member.id);
                        await load();
                      })
                    }
                  >
                    {action.busy === "promote" ? "Promoting…" : "Make leader"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {me !== null && (
          <section className="auth-card notched notched-sm">
            {action.error !== null && (
              <p className="field-error" role="alert">
                {action.error}
              </p>
            )}
            {mine ? (
              <button
                type="button"
                className="btn btn-ghost"
                data-dev="clan-leave"
                disabled={action.busy !== null}
                onClick={() =>
                  void action.run("leave", async () => {
                    await accountClient.leaveClan();
                    await refresh();
                    await load();
                  })
                }
              >
                {action.busy === "leave" ? "Leaving…" : "Leave this clan"}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                data-dev="clan-join"
                disabled={action.busy !== null}
                onClick={() =>
                  void action.run("join", async () => {
                    await accountClient.joinClan(clan.tag);
                    await refresh();
                    await load();
                  })
                }
              >
                {action.busy === "join" ? "Joining…" : "Join"}
              </button>
            )}
          </section>
        )}
      </div>
    </>
  );
}
