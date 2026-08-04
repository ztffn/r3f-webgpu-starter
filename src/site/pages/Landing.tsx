// Landing page — the front door and the whole top of the funnel.
//
// One job above all others: get an anonymous visitor into a live match in one
// click. "Play now" is therefore the primary action in the hero, it does not ask
// for an account, and the account pitch is deliberately placed far below it.
// Visual direction: design/distant-front-landing-modern-army.

import { Link } from "react-router";
import { InsigniaPatch } from "../../ui/Insignia";
import { BRAND } from "../../ui/brand";
import { useDocumentTitle } from "../useDocumentTitle";
import "./landing.css";

const FACTS = [
  {
    title: "Long-range combat",
    body: "Engagement distances measured in terrain, not corridors. Bullets take time to arrive and wind moves them.",
  },
  {
    title: "Vast open ground",
    body: "A heightfield that tiles without end, readable at range, with distant silhouettes you have to work to identify.",
  },
  {
    title: "Grass that hides you",
    body: "Concealment is a real field the renderer and the line-of-sight check both read. Going prone genuinely works.",
  },
];

const PILLARS = [
  {
    n: "01",
    title: "Distance is gameplay",
    body: "Terrain, optics, ballistics and visibility shape every encounter before anyone fires.",
  },
  {
    n: "02",
    title: "Grass is concealment",
    body: "Vegetation is tactical geometry, not decoration — and the server reads the same field you do.",
  },
  {
    n: "03",
    title: "Small teams, large spaces",
    body: "Recon-scale operations across battlefields that feel genuinely open rather than fenced.",
  },
  {
    n: "04",
    title: "Legacy without imitation",
    body: "Original technology, art and missions carrying a recognisable design philosophy forward.",
  },
];

export function Landing() {
  useDocumentTitle(undefined, BRAND.blurb);

  return (
    <>
      <section className="hero">
        <div className="shell hero-grid">
          <div className="hero-patch">
            <InsigniaPatch />
          </div>

          <div className="hero-copy">
            <p className="eyebrow">Playable in your browser</p>
            <h1 className="display display-xl">
              Distant <span>Front</span>
            </h1>
            <p className="hero-lede">{BRAND.heroLede}</p>

            <div className="hero-actions">
              <Link className="btn btn-primary" to="/play">
                Play now
              </Link>
              <Link className="btn btn-ghost" to="/faq">
                What is this?
              </Link>
            </div>
            {/* The reassurance belongs next to the button, not in a FAQ: the
                single biggest drop-off on a page like this is the visitor
                assuming they are about to hit a signup wall. */}
            <p className="hero-note">
              No download, no account. Registering later keeps your medals and
              loadouts.
            </p>
          </div>
        </div>
      </section>

      <div className="facts">
        <div className="shell facts-grid">
          {FACTS.map((fact) => (
            <article className="fact" key={fact.title}>
              <h2 className="display display-sm">{fact.title}</h2>
              <p>{fact.body}</p>
            </article>
          ))}
        </div>
      </div>

      <section className="site-section" id="mission">
        <div className="shell site-split">
          <div>
            <p className="eyebrow">The mission</p>
            <h2 className="display display-lg">Bring back the battlefield.</h2>
          </div>
          <div className="prose">
            <p>
              <strong>
                {BRAND.name} is not a modern hero shooter wearing an old name.
              </strong>{" "}
              It is a deliberate continuation of the design language that made the
              early Delta Force games distinctive: enormous terrain, vulnerable
              soldiers, uncertain sightlines, sparse information, and the constant
              tension between moving and being seen.
            </p>
            <p>
              It is built by modders and mapmakers from the original NovaLogic
              community, on a renderer written for the browser. The technology is
              new. The priorities are not.
            </p>
          </div>
        </div>
      </section>

      <section className="site-section" id="pillars">
        <div className="shell site-split">
          <div>
            <p className="eyebrow">Design pillars</p>
            <h2 className="display display-lg">Fieldcraft over fireworks.</h2>
          </div>
          <div className="pillars">
            {PILLARS.map((pillar) => (
              <article className="pillar notched notched-sm" key={pillar.n}>
                <span className="pillar-n">{pillar.n}</span>
                <h3 className="display display-sm">{pillar.title}</h3>
                <p>{pillar.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="site-section" id="community">
        <div className="shell site-split">
          <div>
            <p className="eyebrow">Community</p>
            <h2 className="display display-lg">Return to the long grass.</h2>
          </div>
          <div className="prose">
            <p>
              Development is early and community-led. Play as a guest for as long
              as you like. Make an account when you want a name that sticks,
              medals that count, and saved loadouts — and back the project if you
              want to run a clan or host a server the rest of us can join.
            </p>
            <div className="row" style={{ marginTop: "var(--s5)" }}>
              <Link className="btn btn-primary" to="/play">
                Play now
              </Link>
              <Link className="btn btn-ghost" to="/supporter">
                Supporter perks
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
