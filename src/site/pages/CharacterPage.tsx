// The loadout screen: weapons left, the soldier centre, appearance right.
//
// Built from the SAME tables and the SAME validator the server uses, which is the
// point: a control the account cannot use is rendered disabled with the reason
// beside it, rather than enabled and then refused by the API. The refusal still
// exists server-side — this is a courtesy, not the gate.
//
// It wears `.skin-hud`, not the site skin. This is the last screen before a match
// and it should read as an instrument, and the weapon figures are the real ones
// the simulation fires rather than invented bars.

import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { accountClient, AccountError } from "../../account/accountClient";
import { useAuth } from "../../account/AuthProvider";
import {
  CAMOS,
  DEFAULT_CHARACTER,
  HEADGEAR,
  INSIGNIA_MAX,
  SELECTABLE_PRIMARY,
  SELECTABLE_SECONDARY,
  validateCharacter,
  weaponLabel,
  weaponSpec,
  type Camo,
  type Character,
} from "../../account/characters";
import { weaponIconStyle } from "../../ui/weaponIcons";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./loadout.css";

/**
 * The ONE place src/site/ is allowed to reach the game, and only through
 * `lazy()`.
 *
 * A static import here would pull Three.js and the renderer into the site's entry
 * chunk — the boundary that keeps the landing page cheap fails silently, so this
 * split is re-checked in dist/ rather than assumed.
 */
const CharacterPreview = lazy(() => import("../../game/CharacterPreview"));

/**
 * A refusal from the API lists every field it objected to, and all of them are
 * worth showing — the validator returns problems rather than throwing precisely
 * so a form can show them at once.
 */
const describeSave = (failure: unknown) =>
  failure instanceof AccountError
    ? failure.problems.map((problem) => problem.message).join(" ") || failure.message
    : "Could not save.";

/**
 * Swatch colours for the camouflage tiles.
 *
 * These label the OPTION — they are not a render of the pattern, and the soldier
 * on the stage does not wear them yet. Kept here rather than in `characters.ts`
 * because they are presentation: the shared module defines which camos exist and
 * must stay free of anything only a screen cares about.
 */
const CAMO_SWATCH: Record<Camo, [string, string, string]> = {
  woodland: ["#3f4a30", "#26301d", "#586647"],
  desert: ["#a9906a", "#87714f", "#c4ae8b"],
  urban: ["#585c5e", "#3b3e40", "#787d80"],
  winter: ["#c9cdc8", "#9aa0a0", "#eceeea"],
  tiger: ["#6b6033", "#2f2b18", "#8f8347"],
};

/** Deploy countdown. Long enough to read the kit, short enough to forgive. */
const DEPLOY_SECONDS = 20;

/**
 * Where "Deploy now" goes: a bare /play would bounce straight back here, so the
 * loadout stop is explicitly spent. GameApp still applies the full networked
 * defaults to this URL — `loadout` is not one of its explicit parameters.
 */
const DEPLOY_URL = "/play?loadout=0";

export function CharacterPage() {
  useDocumentTitle("Loadout");
  const { me, loading, refresh, can } = useAuth();
  const navigate = useNavigate();

  /**
   * `?deploy=1`: this screen is the stop between "Play now" and the match. Same
   * page, two extra things — a countdown that deploys on zero, and a guest path
   * that seeds the default character instead of demanding a sign-in, because the
   * FAQ promises a match without an account.
   */
  const deployMode =
    new URLSearchParams(useLocation().search).get("deploy") === "1";

  const [draft, setDraft] = useState<Character | null>(null);
  const { busy, error, done: saved, run } = useAsyncAction<"save">(describeSave);

  // Seeded from the account once it arrives. Not derived on every render, or
  // typing in the insignia field would be overwritten by the stored value.
  useEffect(() => {
    if (draft !== null) return;
    if (me !== null) setDraft(structuredClone(me.character));
    else if (deployMode && !loading) setDraft(structuredClone(DEFAULT_CHARACTER));
  }, [me, draft, deployMode, loading]);

  // The deploy clock. One interval; deploying is a navigation, so reaching zero
  // fires it once and the unmount clears the timer.
  const [seconds, setSeconds] = useState(DEPLOY_SECONDS);
  useEffect(() => {
    if (!deployMode) return;
    const timer = window.setInterval(
      () => setSeconds((was) => Math.max(0, was - 1)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [deployMode]);
  useEffect(() => {
    if (deployMode && seconds === 0) navigate(DEPLOY_URL);
  }, [deployMode, seconds, navigate]);

  // Warm the game chunk while the countdown runs — the same dynamic-import shape
  // as the /play route, so the split stays intact; this only moves the fetch
  // forward to where the player is reading their kit instead of a loading bar.
  useEffect(() => {
    if (deployMode) void import("../../game/GameApp");
  }, [deployMode]);

  if (loading) {
    return (
      <div className="shell page-body">
        <p className="prose">Loading your loadout…</p>
      </div>
    );
  }

  if (me === null && !deployMode) {
    return (
      <div className="shell notfound">
        <p className="eyebrow">Not signed in</p>
        <h1 className="display display-lg">No loadout to edit.</h1>
        <Link className="btn btn-primary" to="/sign-in">
          Sign in
        </Link>
      </div>
    );
  }

  if (draft === null) return null;

  const canSaveLoadout = can("savedLoadouts");
  const canInsignia = can("customInsignia");
  // The same validator the API runs, against the same effective tier — so the
  // Save button is disabled for exactly the reasons the server would refuse.
  const problems = validateCharacter(draft, me?.effectiveTier ?? "guest");

  const setAppearance = (patch: Partial<Character["appearance"]>) =>
    setDraft((current) =>
      current === null ? current : { ...current, appearance: { ...current.appearance, ...patch } }
    );
  const setLoadout = (patch: Partial<Character["loadout"]>) =>
    setDraft((current) =>
      current === null ? current : { ...current, loadout: { ...current.loadout, ...patch } }
    );

  const onSave = () => {
    void run("save", async () => {
      await accountClient.saveCharacter(draft);
      await refresh();
    });
  };

  // The spec block follows the PRIMARY, because that is the choice with
  // consequences — the sidearm is currently a single option.
  const spec = weaponSpec(draft.loadout.primary);

  const status: { tone: "bad" | "good" | "quiet"; text: string } =
    problems.length > 0
      ? { tone: "bad", text: problems.map((problem) => problem.message).join(" · ") }
      : error !== null
        ? { tone: "bad", text: error }
        : saved
          ? { tone: "good", text: "Loadout saved" }
          : me === null
            ? { tone: "quiet", text: "Guest — sign in to keep a custom kit" }
            : { tone: "quiet", text: `${me.account.callsign} · ${me.effectiveTier}` };

  return (
    <div className="skin-hud loadout" data-dev="loadout">
      <header className="loadout-head">
        <h1>Loadout</h1>
        <div className="faction-tabs" role="group" aria-label="Faction">
          {(["ranger", "opfor"] as const).map((faction) => (
            <button
              key={faction}
              type="button"
              data-dev={`faction-${faction}`}
              aria-pressed={draft.appearance.faction === faction}
              onClick={() => setAppearance({ faction })}
            >
              {faction === "ranger" ? "Ranger" : "OpFor"}
            </button>
          ))}
        </div>
        <h2>Customisation</h2>
      </header>

      <div className="loadout-body">
        <div className="loadout-col">
          {/* One group per SLOT, with its options inside. The role was on every
              row before, so two primary choices both read "PRIMARY" and looked
              like two primary weapons rather than a choice between two. */}
          <section className="kit-group">
            <h3 className="kit-title">Primary</h3>
            {SELECTABLE_PRIMARY.map((id) => (
              <button
                key={id}
                type="button"
                className="slot"
                data-dev={`primary-${id}`}
                aria-pressed={draft.loadout.primary === id}
                disabled={!canSaveLoadout}
                onClick={() => setLoadout({ primary: id })}
              >
                {weaponIconStyle(id) !== undefined && (
                  <span className="slot-icon" style={weaponIconStyle(id)} aria-hidden="true" />
                )}
                <span className="slot-name">{weaponLabel(id)}</span>
                <span className="slot-mark" aria-hidden="true">
                  ◆
                </span>
              </button>
            ))}
          </section>

          <section className="kit-group">
            <h3 className="kit-title">Sidearm</h3>
            {SELECTABLE_SECONDARY.map((id) => (
              <button
                key={id}
                type="button"
                className="slot"
                data-dev={`secondary-${id}`}
                aria-pressed={draft.loadout.secondary === id}
                disabled={!canSaveLoadout}
                onClick={() => setLoadout({ secondary: id })}
              >
                {weaponIconStyle(id) !== undefined && (
                  <span className="slot-icon" style={weaponIconStyle(id)} aria-hidden="true" />
                )}
                <span className="slot-name">{weaponLabel(id)}</span>
                <span className="slot-mark" aria-hidden="true">
                  ◆
                </span>
              </button>
            ))}
            {!canSaveLoadout && (
              <p className="kit-note">
                <Link to="/register">Register</Link> to keep your own kit. Free,
                and you keep what you have earned.
              </p>
            )}
          </section>

          <section className="kit-group">
            <h3 className="kit-title">{weaponLabel(draft.loadout.primary)}</h3>
            {/* Real figures from the weapon the simulation fires — no ratings
                out of ten, because the game has no such number. */}
            <dl className="spec" data-dev="weapon-spec">
              {spec.map((line) => (
                <div key={line.label} style={{ display: "contents" }}>
                  <dt>{line.label}</dt>
                  <dd>{line.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <div className="stage">
          {/* Loaded on arrival, with no button in front of it. This screen is
              onboarding — the soldier IS the reason to play, and asking someone
              to opt in to seeing it was the wrong instinct. It is not a cost
              either: `loadSoldier` memoizes at module scope and the match loads
              the same GLB, so opening this screen PRELOADS the game. */}
          <div className="stage-figure" data-dev="loadout-stage">
            <div className="stage-canvas">
              <Suspense fallback={<p className="stage-loading">Standing by</p>}>
                <CharacterPreview />
              </Suspense>
            </div>
          </div>
          {/* No caption. The paragraph that was here explained an unrendered
              appearance system and a fair-play position — a developer's caveat
              and a policy note, neither of which a player wants between them and
              their soldier. The gap is recorded in the design record §5.6, which
              is where a known gap belongs; the fair-play line is argued once, on
              the supporter page, where someone is actually deciding to pay. */}
        </div>

        <div className="loadout-col">
          <section className="kit-group">
            <h3 className="kit-title">Camouflage</h3>
            <div className="tiles">
              {CAMOS.map((camo) => {
                const [base, dark, light] = CAMO_SWATCH[camo];
                return (
                  <button
                    key={camo}
                    type="button"
                    className="tile"
                    data-dev={`camo-${camo}`}
                    aria-pressed={draft.appearance.camo === camo}
                    onClick={() => setAppearance({ camo })}
                  >
                    <span
                      className="tile-swatch"
                      aria-hidden="true"
                      style={
                        {
                          "--swatch": base,
                          "--swatch-b": dark,
                          "--swatch-c": light,
                        } as React.CSSProperties
                      }
                    />
                    <span className="tile-name">{camo}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="kit-group">
            <h3 className="kit-title">Headwear</h3>
            <div className="tiles">
              {HEADGEAR.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="tile tile-plain"
                  data-dev={`headgear-${item}`}
                  aria-pressed={draft.appearance.headgear === item}
                  onClick={() => setAppearance({ headgear: item })}
                >
                  <span className="tile-name">{item}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="kit-group">
            <h3 className="kit-title">Unit insignia</h3>
            <div className="insignia-row">
              <span
                className="insignia-patch"
                data-empty={draft.appearance.insignia === null}
                aria-hidden="true"
              >
                {draft.appearance.insignia ?? "––"}
              </span>
              <input
                id="insignia"
                type="text"
                maxLength={INSIGNIA_MAX}
                value={draft.appearance.insignia ?? ""}
                disabled={!canInsignia}
                placeholder={canInsignia ? "e.g. 3RD" : "Locked"}
                // A lone four-character text field is irresistible to a browser's
                // address autofill, which put "=NR=" in it during testing and
                // then failed validation for a value nobody typed.
                autoComplete="off"
                aria-label="Unit insignia"
                data-dev="insignia"
                data-dev-locked={canInsignia ? undefined : "supporter"}
                onChange={(event) =>
                  setAppearance({
                    insignia:
                      event.target.value === ""
                        ? null
                        : event.target.value.toUpperCase().slice(0, INSIGNIA_MAX),
                  })
                }
              />
            </div>
            {canInsignia ? (
              <p className="kit-note">
                {INSIGNIA_MAX} characters, worn on the shoulder.
              </p>
            ) : (
              <p className="kit-locked">Supporter perk</p>
            )}
          </section>
        </div>
      </div>

      <div className="loadout-bar">
        <Link className="btn btn-ghost btn-sm" to={deployMode ? "/" : "/profile"}>
          Back
        </Link>
        <p
          className="bar-status"
          data-tone={status.tone}
          data-dev="loadout-status"
          role={status.tone === "bad" ? "alert" : "status"}
        >
          {status.text}
        </p>
        {deployMode ? (
          <div className="bar-actions">
            {me !== null && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-dev="character-save"
                disabled={busy !== null || problems.length > 0}
                onClick={onSave}
              >
                {busy !== null ? "Saving…" : "Save"}
              </button>
            )}
            <span className="deploy-count" data-dev="deploy-count" role="timer">
              Game starts in {seconds}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              data-dev="deploy-now"
              onClick={() => navigate(DEPLOY_URL)}
            >
              Deploy now
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            data-dev="character-save"
            disabled={busy !== null || problems.length > 0}
            onClick={onSave}
          >
            {busy !== null ? "Saving…" : "Save loadout"}
          </button>
        )}
      </div>
    </div>
  );
}
