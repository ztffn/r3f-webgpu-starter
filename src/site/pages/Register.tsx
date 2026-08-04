// Register — and, when the visitor is already a guest, UPGRADE their account.
//
// The distinction is the whole funnel, so the page says which one is happening.
// A guest arriving here is told their progress carries over, because the fear that
// registering resets you is exactly what stops people registering. The callsign is
// validated with the same function the server uses, so the error appears as you
// type rather than after a round trip.

import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { accountClient, AccountError } from "../../account/accountClient";
import { useAuth } from "../../account/AuthProvider";
import { validateCallsign } from "../../account/accountTypes";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";

/** Matches @colyseus/auth's own minimum, so the server cannot refuse a value the form accepted. */
const PASSWORD_MIN = 6;

export function Register() {
  useDocumentTitle("Register");
  const { me } = useAuth();
  const navigate = useNavigate();

  const upgrading = me !== null && me.account.anonymous;

  const [callsign, setCallsign] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callsignProblem = callsign === "" ? null : validateCallsign(callsign);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;
    if (callsignProblem !== null) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        // The client sends whatever token it holds. If that is a guest token the
        // server upgrades that row in place; the caller does not have to ask for it.
        // No explicit refresh: setToken notifies AuthProvider's subscription,
        // which fetches /api/me. Awaiting one here made the same request twice,
        // with both racing to set the same state.
        await accountClient.register(email, password, callsign);
        navigate("/profile");
      } catch (problem) {
        setError(problem instanceof AccountError ? problem.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">{upgrading ? "Keep your progress" : "Register"}</p>
          <h1 className="display display-lg">
            {upgrading ? "Make it permanent." : "Pick a callsign."}
          </h1>
          {upgrading && (
            <p className="prose" style={{ marginTop: "var(--s4)" }}>
              You are playing as <strong>{me.account.callsign}</strong>. Registering
              keeps this same account — your career, medals and character stay
              exactly as they are, and you gain a name that persists, saved
              loadouts and private matches.
            </p>
          )}
        </div>
      </header>

      <div className="shell page-body auth-page">
        <section className="auth-card notched notched-sm">
          <form className="stack" onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="callsign">Callsign</label>
              <input
                id="callsign"
                name="callsign"
                type="text"
                autoComplete="username"
                value={callsign}
                data-dev="register-callsign"
                onChange={(event) => setCallsign(event.target.value)}
                required
              />
              {callsignProblem !== null ? (
                <p className="field-error">{callsignProblem.message}</p>
              ) : (
                <p className="field-hint">
                  What other players see. Letters, numbers and underscores.
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
              <p className="field-hint">Used to sign in and to reset your password.</p>
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN}
                required
              />
              <p className="field-hint">At least {PASSWORD_MIN} characters.</p>
            </div>

            {error !== null && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="btn btn-primary"
              data-dev="register-submit"
              disabled={busy || callsignProblem !== null}
            >
              {busy ? "Enlisting…" : upgrading ? "Keep my progress" : "Create account"}
            </button>
          </form>

          <p className="auth-note">
            Already registered? <Link to="/sign-in">Sign in</Link>.
          </p>
        </section>
      </div>
    </>
  );
}
