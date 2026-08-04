// Supporter page — the tiers, and the promise that bounds them.
//
// Renders src/account/tiers.ts rather than its own copy of the perk list, so the
// page cannot advertise something no gate enforces. Checkout is deliberately not
// wired yet (VITE_CHECKOUT off): the button says so instead of pretending, since
// a dead payment button costs more trust than an honest "not yet".

import { Link } from "react-router";
import { CAPABILITY_LABELS, TIERS, formatPrice, type Capability } from "../../account/tiers";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";

/** Real checkout arrives in a later phase; see the design record §2.4. */
const CHECKOUT_ENABLED = import.meta.env.VITE_CHECKOUT === "1";

/**
 * Capabilities listed on every card, so the columns line up and a reader can see
 * what a cheaper tier does *not* include rather than having to diff two lists.
 */
const SHOWN: Capability[] = [
  "persistentName",
  "medals",
  "careerStats",
  "savedLoadouts",
  "friends",
  "joinPrivateGame",
  "hostPrivateGame",
  "foundClan",
  "hostCommunityServer",
  "reservedSlot",
  "customInsignia",
  "earlyAccessMaps",
];

export function Supporter() {
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
                  (CHECKOUT_ENABLED ? (
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

        {!CHECKOUT_ENABLED && (
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
