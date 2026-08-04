// Supporter page — the tiers, and the promise that bounds them.
//
// Renders src/account/tiers.ts rather than its own copy of the perk list, so the
// page cannot advertise something no gate enforces. Whether checkout is live comes
// from the SERVER (/api/config), not from a build-time flag: the button says "not
// yet" instead of pretending, and a dead payment button costs more trust than that.

import { Link } from "react-router";
import { accountClient } from "../../account/accountClient";
import {
  CAPABILITY_LABELS,
  TIERS,
  formatPrice,
  tierById,
  type Capability,
} from "../../account/tiers";
import { useAuth } from "../../account/AuthProvider";
import { useAsyncAction } from "../useAsyncAction";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";
import "./auth.css";

/**
 * Capabilities listed on every card, so the columns line up and a reader can see
 * what a cheaper tier does NOT include rather than having to diff two lists.
 *
 * DERIVED from the top tier rather than hand-listed. A copy here had already
 * drifted — it was missing `supporterMarker` — which is exactly the drift the one
 * table exists to prevent, and it made this file's own header comment false.
 */
const SHOWN: readonly Capability[] = tierById("supporter").capabilities;

export function Supporter() {
  // The SERVER decides whether checkout is live, not the build. Two flags meant
  // the page could offer a checkout the server would refuse to honour.
  const { config, me, refresh } = useAuth();
  const checkoutEnabled = config?.checkoutEnabled === true;
  // The dev grant, and ONLY when the server says its route is open. A build-time
  // flag would put this button on a production page whose server answers 404.
  const grantEnabled = config?.grantEnabled === true && me !== null;
  const grant = useAsyncAction<"grant" | "revoke">();
  useDocumentTitle(
    "Supporter",
    "Back Distant Front: found a clan, host a community server, and get your own insignia. Nothing purchasable affects a fight."
  );

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">Membership</p>
          <h1 className="display display-lg">Play free. Back it if you want to run it.</h1>
          <p className="prose" style={{ marginTop: "var(--s4)" }}>
            The game is free and stays free. Supporting it pays for servers and
            buys you the tools to build something on top of it — a clan, a server,
            a squad with your own patch on it.
          </p>
        </div>
      </header>

      <div className="shell page-body">
        <section className="tiers">
          {TIERS.map((tier) => {
            const featured = tier.id === "supporter";
            return (
              <article
                className={`tier notched notched-sm${featured ? " tier-featured" : ""}`}
                key={tier.id}
              >
                <div className="tier-head">
                  {/* The tag sits in its own always-present row rather than
                      beside the name. Inline, the two cards that have a tag were
                      taller than the one that does not, so "Free", "Free" and
                      "$5" landed on three different baselines. */}
                  <div className="tier-tag">
                    {featured && <span className="badge badge-accent">Funds the project</span>}
                    {tier.id === "guest" && <span className="badge">No account</span>}
                  </div>
                  <h2 className="display display-sm">{tier.name}</h2>
                  <p className="tier-price">
                    {formatPrice(tier)}
                    {tier.priceMinor > 0 && <small> / month</small>}
                  </p>
                  <p className="tier-summary">{tier.summary}</p>
                </div>

                <ul className="tier-perks">
                  {SHOWN.map((capability) => {
                    const granted = tier.capabilities.includes(capability);
                    return (
                      <li
                        key={capability}
                        className={granted ? undefined : "tier-perk-off"}
                      >
                        <span>{CAPABILITY_LABELS[capability]}</span>
                      </li>
                    );
                  })}
                </ul>

                {tier.id === "guest" && (
                  <Link className="btn btn-ghost" to="/play">
                    Play as a guest
                  </Link>
                )}
                {tier.id === "enlisted" && (
                  <Link className="btn btn-ghost" to="/play">
                    Start playing, register later
                  </Link>
                )}
                {tier.id === "supporter" &&
                  (checkoutEnabled ? (
                    <Link className="btn btn-primary" to="/supporter/checkout">
                      Become a supporter
                    </Link>
                  ) : (
                    <button className="btn btn-primary" type="button" disabled>
                      Opening soon
                    </button>
                  ))}
              </article>
            );
          })}
        </section>

        {!checkoutEnabled && (
          <section className="callout notched notched-sm">
            <h2 className="display display-sm">Why you cannot pay yet</h2>
            <div className="prose">
              <p>
                Because there is not enough game to sell. Taking a subscription for
                a pre-alpha means owing refunds and support on something that
                changes weekly, so the tiers are published to be argued with and
                the checkout stays shut until the game is worth it.
              </p>
              <p>
                Everything on the free tiers works as described, and none of it is
                waiting on payment.
              </p>
            </div>
          </section>
        )}

        {grantEnabled && (
          <section className="callout notched notched-sm" data-dev="tier-grant">
            <h2 className="display display-sm">Development: grant a tier</h2>
            <div className="prose">
              <p>
                This server was started with <code>DF2_ADMIN=1</code>, so it will
                put your own account on any tier without a payment. It exists to
                exercise the gates — hosting a private game, custom insignia —
                before there is a checkout to do it properly. On any other server
                the route does not exist.
              </p>
              <p>
                It cannot award a medal, and no version of it ever will. Medals
                come from play, which is what the rest of this page is promising.
              </p>
            </div>
            <p className="auth-note" data-dev="tier-grant-state">
              You are <strong>{me.effectiveTier}</strong>
              {me.account.tierExpiresAt !== null &&
                ` until ${me.account.tierExpiresAt.slice(0, 10)}`}
              .
            </p>
            {grant.error !== null && (
              <p className="field-error" role="alert">
                {grant.error}
              </p>
            )}
            <div className="row">
              <button
                type="button"
                className="btn"
                data-dev="grant-supporter"
                disabled={grant.busy !== null}
                onClick={() =>
                  void grant.run("grant", async () => {
                    await accountClient.grantTier("supporter", 30);
                    await refresh();
                  })
                }
              >
                {grant.busy === "grant" ? "Granting…" : "Grant supporter, 30 days"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                data-dev="grant-enlisted"
                disabled={grant.busy !== null}
                onClick={() =>
                  void grant.run("revoke", async () => {
                    await accountClient.grantTier("enlisted");
                    await refresh();
                  })
                }
              >
                {grant.busy === "revoke" ? "Dropping…" : "Back to enlisted"}
              </button>
            </div>
          </section>
        )}

        <section className="callout notched notched-sm">
          <h2 className="display display-sm">The fair-play line</h2>
          <div className="prose">
            <p>
              <strong>
                Nothing purchasable will ever affect concealment, ballistics or
                visibility.
              </strong>{" "}
              Those three decide every fight in this game, which makes them the
              exact things that must not be for sale. No paid optic, no reduced
              fog, no faster reload.
            </p>
            <p>
              Supporters get to <em>run things</em>. Players get to{" "}
              <em>have done things</em> — medals and career milestones come only
              from play, and no tier can shortcut one. If a proposed perk ever
              fails that test, it does not ship. See the{" "}
              <Link to="/faq">FAQ</Link> for the longer version.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
