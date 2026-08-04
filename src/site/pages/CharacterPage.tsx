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
import { Link } from "react-router";
import { accountClient, AccountError } from "../../account/accountClient";
import { useAuth } from "../../account/AuthProvider";
import {
  CAMOS,
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

export function CharacterPage() {
  useDocumentTitle("Loadout");
  const { me, loading, refresh, can } = useAuth();

  const [draft, setDraft] = useState<Character | null>(null);
  const { busy, error, done: saved, run } = useAsyncAction<"save">(describeSave);

  // Seeded from the account once it arrives. Not derived on every render, or
  // typing in the insignia field would be overwritten by the stored value.
  useEffect(() => {
    if (me !== null && draft === null) setDraft(structuredClone(me.character));
  }, [me, draft]);

  if (loading) {
    return (
      <div className="shell page-body">
        <p className="prose">Loading your loadout…</p>
      </div>
    );
  }

  if (me === null) {
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
  const problems = validateCharacter(draft, me.effectiveTier);

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
                <span className="slot-name">{weaponLabel(id)}</span>
                <span className="slot-mark" aria-hidden="true">
                  ◆
                </span>
              </button>
            ))}
            {!canSaveLoadout && (
              <p className="kit-note">
                Guests deploy with the standard kit.{" "}
                <Link to="/register">Register</Link> to save your own — it is free
                and keeps the progress you already have.
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
          <p className="stage-caption">
            Appearance is cosmetic and always will be — camouflage does not change
            how well the grass hides you.{" "}
            <strong>The model does not wear your choices yet:</strong> they are
            saved and enforced, but nothing renders them on the soldier so far.
          </p>
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
                Up to {INSIGNIA_MAX} capitals or digits, worn on the shoulder.
              </p>
            ) : (
              <p className="kit-locked">Supporter perk</p>
            )}
          </section>
        </div>
      </div>

      <div className="loadout-bar">
        <Link className="btn btn-ghost btn-sm" to="/profile">
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
        <button
          type="button"
          className="btn btn-primary"
          data-dev="character-save"
          disabled={busy !== null || problems.length > 0}
          onClick={onSave}
        >
          {busy !== null ? "Saving…" : "Save loadout"}
        </button>
      </div>
    </div>
  );
}
