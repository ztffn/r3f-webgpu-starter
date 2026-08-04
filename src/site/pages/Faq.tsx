// FAQ — the page that has to be honest.
//
// A pre-alpha's FAQ earns more trust by naming what does not work than by
// selling what does, so the hardware, platform and multiplayer answers state the
// current limits plainly. Built on native <details> elements: they are keyboard
// accessible and deep-linkable without a disclosure library, and automation can
// open one by its summary text.

import { Link } from "react-router";
import { BRAND } from "../../ui/brand";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";

interface Entry {
  q: string;
  a: React.ReactNode;
}

const GROUPS: { group: string; entries: Entry[] }[] = [
  {
    group: "Getting in",
    entries: [
      {
        q: "What is Distant Front?",
        a: (
          <>
            <p>
              A long-range tactical shooter that runs in a browser tab. It is a
              reconstruction of what made the early Delta Force games feel
              distinct — enormous heightfield terrain, engagements at hundreds of
              metres, and tall grass that genuinely conceals a prone soldier —
              rebuilt on a modern renderer rather than emulated.
            </p>
            <p>
              It is a hobby project, built in the open, and it is early. Expect
              rough edges and expect them to be visible.
            </p>
          </>
        ),
      },
      {
        q: "Do I need an account to play?",
        a: (
          <p>
            No. <Link to="/play">Play now</Link> drops you straight into a match
            as a guest and never asks for anything. An account is worth having
            later — it keeps your name, your medals, your career stats and your
            saved loadouts, and it lets you join private games — but you can play
            indefinitely without one, and registering afterwards carries your
            guest progress across rather than starting you over.
          </p>
        ),
      },
      {
        q: "What do I need to run it?",
        a: (
          <>
            <p>
              A recent browser. The renderer targets <strong>WebGPU</strong> and
              falls back to WebGL2 automatically, so Chrome, Edge and recent
              Safari and Firefox all work — WebGPU is noticeably faster where it
              is available. There is nothing to download and nothing to install.
            </p>
            <p>
              A discrete or recent integrated GPU helps considerably, because the
              grass is a per-pixel raymarch rather than a texture, and that is the
              single most expensive thing on screen.
            </p>
          </>
        ),
      },
    ],
  },
  {
    group: "Platforms",
    entries: [
      {
        q: "Does it work on a phone or an iPad?",
        a: (
          <>
            <p>
              <strong>Partly, and honestly not yet well.</strong> Every page of
              this site is built for a phone, and the game will render on a
              tablet, but there is currently no touch control scheme — movement
              needs a keyboard, so a phone or iPad can look around and not much
              else.
            </p>
            <p>
              Touch controls and a touch-specific HUD layout are the next
              platform milestone, and the grass renderer needs measuring on mobile
              hardware before we promise a frame rate. A Bluetooth keyboard and
              mouse on an iPad works today.
            </p>
          </>
        ),
      },
      {
        q: "Will desktop and mobile players share matches?",
        a: (
          <p>
            No. A mouse and a touchscreen are not comparable at 400 metres, and
            pretending otherwise makes both experiences worse. Desktop and touch
            get separate queues. Your account, your progress, your medals and your
            cosmetics are shared across every device you sign in on — only the
            lobby you land in differs.
          </p>
        ),
      },
    ],
  },
  {
    group: "The game",
    entries: [
      {
        q: "Is it multiplayer?",
        a: (
          <p>
            Yes, and it is authoritative — the server runs the same character
            physics your browser does, so movement is predicted locally and
            corrected against the server rather than trusted. It is early: player
            movement and the world are replicated, and combat is still being moved
            onto the server.
          </p>
        ),
      },
      {
        q: "Why is everyone so obsessed with the grass?",
        a: (
          <>
            <p>
              Because it is the mechanic. In the game this reconstructs, tall
              grass could hide a prone sniper at extreme range, which turned
              patience into a viable tactic and made open ground genuinely
              dangerous to cross.
            </p>
            <p>
              That only works if the concealment is real, so the grass height is a
              field that the renderer <em>and</em> the line-of-sight check both
              read from. If you cannot see someone in the grass, neither can the
              server. Fog works the same way and is owned by the match, not by
              your settings — otherwise turning fog off would be an aimbot.
            </p>
          </>
        ),
      },
      {
        q: "Can I host my own server?",
        a: (
          <p>
            That is planned, and it is one of the{" "}
            <Link to="/supporter">supporter perks</Link>: a persistent
            community-hosted server that appears in the public browser, with you
            administering it. Private matches by invite code are coming for every
            registered account.
          </p>
        ),
      },
    ],
  },
  {
    group: "Money and legality",
    entries: [
      {
        q: "Is any of this pay-to-win?",
        a: (
          <p>
            No, and there is a hard line drawn around it: nothing purchasable may
            affect concealment, ballistics, visibility or anything else that
            decides a fight. Supporters get to <em>run things</em> — clans,
            servers, insignia. Players get to <em>have done things</em> — medals
            and career milestones come only from play and cannot be bought.
          </p>
        ),
      },
      {
        q: "Is this official? Is it legal?",
        a: (
          <>
            <p>
              It is neither official nor affiliated. {BRAND.legal}
            </p>
            <p>
              The terrain you play on comes from community-authored freeware
              expansion packs, made for redistribution by the same modding
              community this project comes from. Original publisher assets are not
              redistributed. The name is deliberately our own.
            </p>
          </>
        ),
      },
      {
        q: "How do I follow development or report something broken?",
        a: (
          <p>
            Community channels are being set up — the{" "}
            <Link to="/supporter">supporter page</Link> is the current place to
            find where they land. Until then, the most useful bug report says what
            hardware and browser you were on, because most of what breaks right
            now is renderer-specific.
          </p>
        ),
      },
    ],
  },
];

export function Faq() {
  useDocumentTitle(
    "FAQ",
    "What Distant Front is, what you need to run it, platform support, and the legal position."
  );

  return (
    <>
      <header className="page-head">
        <div className="shell">
          <p className="eyebrow">Frequently asked</p>
          <h1 className="display display-lg">Questions, answered plainly.</h1>
          <p className="prose" style={{ marginTop: "var(--s4)" }}>
            Including the ones where the answer is "not yet".
          </p>
        </div>
      </header>

      <div className="shell page-body">
        {GROUPS.map((group) => (
          <section className="faq-group" key={group.group}>
            <h2 className="eyebrow faq-group-title">{group.group}</h2>
            {group.entries.map((entry) => (
              <details className="faq-item notched notched-sm" key={entry.q}>
                <summary>
                  <span>{entry.q}</span>
                  <i aria-hidden="true" />
                </summary>
                <div className="prose faq-answer">{entry.a}</div>
              </details>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
