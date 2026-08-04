// Character editor: appearance and loadout, with the locks made visible.
//
// Built from the SAME tables and the SAME validator the server uses, which is the
// point: a control the account cannot use is rendered disabled with the reason
// beside it, rather than enabled and then refused by the API. The refusal still
// exists server-side — this is a courtesy, not the gate.

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
  type Character,
} from "../../account/characters";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";

/**
 * A refusal from the API lists every field it objected to, and all of them are
 * worth showing — the validator returns problems rather than throwing precisely
 * so a form can show them at once.
 */
/**
 * The ONE place src/site/ is allowed to reach the game, and only through
 * `lazy()`.
 *
 * A static import here would pull Three.js and the renderer into the site's entry
 * chunk — the boundary that keeps the landing page cheap fails silently, so this
 * split is re-checked in dist/ rather than assumed.
 */
const CharacterPreview = lazy(() => import("../../game/CharacterPreview"));

const describeSave = (failure: unknown) =>
  failure instanceof AccountError
    ? failure.problems.map((problem) => problem.message).join(" ") || failure.message
    : "Could not save.";

export function CharacterPage() {
  useDocumentTitle("Character");
  const { me, loading, refresh, can } = useAuth();

  const [draft, setDraft] = useState<Character | null>(null);
  const { busy, error, done: saved, run } = useAsyncAction<"save">(describeSave);
  // Mounted on request, not on arrival: the model is 7 MB and the renderer is
  // another 1.5, on a page whose whole point is that it costs nothing to open.
  const [showPreview, setShowPreview] = useState(false);

  // Seeded from the account once it arrives. Not derived on every render, or
  // typing in the insignia field would be overwritten by the stored value.
  useEffect(() => {
    if (me !== null && draft === null) setDraft(structuredClone(me.character));
  }, [me, draft]);

  if (loading) {
    return (
      <div className="shell page-body">
        <p className="prose">Loading your character…</p>
      </div>
    );
  }

  if (me === null) {
    return (
      <div className="shell notfound">
        <p className="eyebrow">Not signed in</p>
        <h1 className="display display-lg">No character to edit.</h1>
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

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">Character</p>
          <h1 className="display display-lg">Kit out.</h1>
          <p className="prose" style={{ marginTop: "var(--s4)" }}>
            Appearance is cosmetic and always will be — camouflage here does not
            change how well the grass hides you, because concealment is decided by
            the terrain and the server, not by your sleeve.
          </p>
        </div>
      </header>

      <div className="shell page-body auth-page">
        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">The soldier</h2>
          <p className="auth-note">
            {/* Said before the model loads, not after. A preview that silently
                ignores the controls beside it is worse than no preview — the
                player would read it as their camo being broken. */}
            This is the model and its idle animation.{" "}
            <strong>It does not show your choices yet</strong> — camouflage,
            headgear and insignia are saved and enforced, but nothing renders them
            on the soldier so far.
          </p>
          {showPreview ? (
            <Suspense
              fallback={
                <p className="auth-note" data-dev="character-preview-pending">
                  Loading the viewer…
                </p>
              }
            >
              <CharacterPreview />
            </Suspense>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              data-dev="character-preview-load"
              onClick={() => setShowPreview(true)}
            >
              Load the 3D view (about 9 MB)
            </button>
          )}
        </section>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Appearance</h2>

          <span className="eyebrow">Faction</span>
          <div className="btns row">
            {(["ranger", "opfor"] as const).map((faction) => (
              <button
                key={faction}
                type="button"
                className="btn btn-sm"
                data-dev={`faction-${faction}`}
                aria-pressed={draft.appearance.faction === faction}
                onClick={() => setAppearance({ faction })}
              >
                {faction === "ranger" ? "Ranger" : "OpFor"}
              </button>
            ))}
          </div>

          <span className="eyebrow">Camouflage</span>
          <div className="btns row">
            {CAMOS.map((camo) => (
              <button
                key={camo}
                type="button"
                className="btn btn-sm"
                data-dev={`camo-${camo}`}
                aria-pressed={draft.appearance.camo === camo}
                onClick={() => setAppearance({ camo })}
              >
                {camo}
              </button>
            ))}
          </div>

          <span className="eyebrow">Headgear</span>
          <div className="btns row">
            {HEADGEAR.map((item) => (
              <button
                key={item}
                type="button"
                className="btn btn-sm"
                data-dev={`headgear-${item}`}
                aria-pressed={draft.appearance.headgear === item}
                onClick={() => setAppearance({ headgear: item })}
              >
                {item}
              </button>
            ))}
          </div>

          <div className="field" style={{ marginTop: "var(--s4)" }}>
            <label htmlFor="insignia">Unit insignia</label>
            <input
              id="insignia"
              type="text"
              maxLength={INSIGNIA_MAX}
              value={draft.appearance.insignia ?? ""}
              disabled={!canInsignia}
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
            <p className={canInsignia ? "field-hint" : "field-error"}>
              {canInsignia
                ? `Up to ${INSIGNIA_MAX} capitals or digits, worn on the shoulder.`
                : "Custom insignia is a supporter perk."}
            </p>
          </div>
        </section>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Loadout</h2>
          {!canSaveLoadout && (
            <p className="auth-note">
              Guests play with the standard loadout. <Link to="/register">Register</Link>{" "}
              to save your own — it is free and keeps everything you already have.
            </p>
          )}

          <span className="eyebrow">Primary</span>
          <div className="btns row">
            {SELECTABLE_PRIMARY.map((id) => (
              <button
                key={id}
                type="button"
                className="btn btn-sm"
                data-dev={`primary-${id}`}
                aria-pressed={draft.loadout.primary === id}
                disabled={!canSaveLoadout}
                onClick={() => setLoadout({ primary: id })}
              >
                {weaponLabel(id)}
              </button>
            ))}
          </div>

          <span className="eyebrow">Sidearm</span>
          <div className="btns row">
            {SELECTABLE_SECONDARY.map((id) => (
              <button
                key={id}
                type="button"
                className="btn btn-sm"
                data-dev={`secondary-${id}`}
                aria-pressed={draft.loadout.secondary === id}
                disabled={!canSaveLoadout}
                onClick={() => setLoadout({ secondary: id })}
              >
                {weaponLabel(id)}
              </button>
            ))}
          </div>
        </section>

        <section className="auth-card notched notched-sm">
          {problems.length > 0 && (
            <ul className="field-error" data-dev="character-problems">
              {problems.map((problem) => (
                <li key={problem.field}>{problem.message}</li>
              ))}
            </ul>
          )}
          {error !== null && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {saved && (
            <p className="field-hint" role="status">
              Saved.
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              data-dev="character-save"
              disabled={busy !== null || problems.length > 0}
              onClick={onSave}
            >
              {busy !== null ? "Saving…" : "Save character"}
            </button>
            <Link className="btn btn-ghost" to="/profile">
              Back to profile
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
