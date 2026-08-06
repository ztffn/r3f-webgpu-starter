// Sign in — and, more importantly, the page that does not block anyone.
//
// "Play as a guest" is the first thing on it and needs no fields, because the
// funnel's whole premise is that nothing is asked for up front. Email sign-in is
// below that, and a Discord button appears only when the server says the provider
// is configured — an unconfigured provider rendered as a button reads as the site
// being broken rather than the feature being off.

import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { accountClient, providerSignInUrl } from "../../account/accountClient";
import { useAuth } from "../../account/AuthProvider";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";

export function SignIn() {
  useDocumentTitle("Sign in");
  const { config } = useAuth();
  const navigate = useNavigate();

  const { busy, error, failed, run } = useAsyncAction<"guest" | "email" | "reset">();
  const [resetSent, setResetSent] = useState(false);

  const onGuest = () =>
    void run("guest", async () => {
      await accountClient.signInAnonymously();
      navigate("/play");
    });

  const onEmail = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;
    void run("email", async () => {
      await accountClient.signIn(email, password);
      navigate("/profile");
    });
  };

  const onReset = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = (form.elements.namedItem("resetEmail") as HTMLInputElement).value;
    void run("reset", async () => {
      await accountClient.requestPasswordReset(email);
      setResetSent(true);
    });
  };

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">Sign in</p>
          <h1 className="display display-lg">Get in the grass.</h1>
        </div>
      </header>

      <div className="shell page-body auth-page">
        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">No account needed</h2>
          <p className="auth-note">
            Play now as a guest. If you register later, the medals, career and
            character you collected come with you — nothing is lost.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            data-dev="signin-guest"
            disabled={busy !== null}
            onClick={onGuest}
          >
            {busy === "guest" ? "Deploying…" : "Play as a guest"}
          </button>
          {error !== null && failed === "guest" && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Email and password</h2>
          <form className="stack" onSubmit={onEmail}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            {/* Scoped to THIS action: one shared error rendered only here put a
                failed guest sign-in or reset request under the unrelated
                email/password fields. */}
            {error !== null && failed === "email" && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="btn"
              data-dev="signin-submit"
              disabled={busy !== null}
            >
              {busy === "email" ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="auth-note">
            No account yet? <Link to="/register">Register</Link>.
          </p>
        </section>

        {config !== null && config.providers.length > 0 && (
          <section className="auth-card notched notched-sm">
            <h2 className="display display-sm">Or use a service</h2>
            <div className="row">
              {config.providers.map((provider) => (
                // A real link, not a fetch: OAuth is a full navigation to the
                // provider and back through the server's callback.
                <a
                  key={provider}
                  className="btn btn-ghost"
                  data-dev={`signin-${provider}`}
                  href={providerSignInUrl(provider)}
                >
                  Continue with {provider}
                </a>
              ))}
            </div>
          </section>
        )}

        <section className="auth-card notched notched-sm">
          <h2 className="display display-sm">Forgotten password</h2>
          {resetSent ? (
            <p className="auth-note" role="status">
              If that address has an account, a reset link is on its way.
            </p>
          ) : (
            <form className="stack" onSubmit={onReset}>
              <div className="field">
                <label htmlFor="resetEmail">Email</label>
                <input id="resetEmail" name="resetEmail" type="email" required />
              </div>
              <button
                type="submit"
                className="btn btn-ghost"
                data-dev="signin-reset"
                disabled={busy !== null}
              >
                {busy === "reset" ? "Sending…" : "Send a reset link"}
              </button>
              {error !== null && failed === "reset" && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          )}
        </section>
      </div>
    </>
  );
}
