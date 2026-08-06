// Supporter checkout — a STUB, and it says so on the page.
//
// It exists because the supporter page links here the moment the server reports
// a payment provider is wired (`/api/config`), and that flag is server-side: with
// no route, the day somebody sets DF2_CHECKOUT=1 the primary call to action on
// the supporter page lands on the 404 page and nothing in the client would have
// caught it. Payment integration is deliberately out of scope for this phase.

import { Link } from "react-router";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";

export function Checkout() {
  useDocumentTitle("Checkout");

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">Supporter</p>
          <h1 className="display display-lg">Not taking money yet.</h1>
        </div>
      </header>

      <div className="shell page-body auth-page">
        <section className="auth-card notched notched-sm" data-dev="checkout-stub">
          <p className="auth-note">
            There is no payment provider connected to this build, so there is
            nothing here to buy. Nothing on the supporter list affects how anyone
            shoots, and it will not while this page is a placeholder either.
          </p>
          <div className="row">
            <Link className="btn btn-ghost" to="/supporter">
              Back to the tiers
            </Link>
            <Link className="btn btn-primary" to="/play">
              Go and play
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
