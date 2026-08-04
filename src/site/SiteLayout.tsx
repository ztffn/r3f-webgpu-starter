// Chrome shared by every public page: skip link, nav, outlet, footer.
//
// Applies `.skin-site` here rather than on <body> so the game and the dev console
// can carry `.skin-hud` on their own roots without the two palettes fighting.
// The mobile nav is a real disclosure button with aria-expanded, not a CSS-only
// checkbox hack, because it has to be reachable by keyboard and by automation.

import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { Insignia } from "../ui/Insignia";
import { BRAND } from "../ui/brand";
import { useAuth } from "../account/AuthProvider";
import "./site.css";
import "./pages/auth.css";

const NAV = [
  { to: "/lobby", label: "Play" },
  { to: "/leaderboard", label: "Standings" },
  { to: "/faq", label: "FAQ" },
  { to: "/supporter", label: "Supporter" },
];

export function SiteLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const { me, loading } = useAuth();

  // Close the mobile menu on navigation. Without this it stays open over the
  // page you just moved to, which reads as the link having failed.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="skin-site site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="site-nav">
        <div className="shell site-nav-inner">
          <Link className="brand" to="/">
            <Insignia size={32} />
            <span>{BRAND.name}</span>
          </Link>

          <nav className="site-nav-links" aria-label="Primary">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="site-nav-actions">
            {/* Account state, and never a spinner: `loading` renders nothing at
                all, because a placeholder that becomes "Sign in" a moment later
                reads as the nav flickering. */}
            {!loading &&
              (me === null ? (
                <Link className="btn btn-ghost btn-sm nav-signin" to="/sign-in">
                  Sign in
                </Link>
              ) : (
                <Link className="nav-account" to="/profile" data-dev="nav-account">
                  <span
                    className={`nav-account-name${me.account.anonymous ? " guest" : ""}`}
                  >
                    {me.account.callsign}
                  </span>
                  {me.account.anonymous && <span className="badge">Guest</span>}
                </Link>
              ))}
            <Link className="btn btn-primary btn-sm" to="/play">
              Play now
            </Link>
            <button
              type="button"
              className="site-nav-toggle"
              aria-expanded={menuOpen}
              aria-controls="site-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="sr-only">{menuOpen ? "Close menu" : "Open menu"}</span>
              <span aria-hidden="true">{menuOpen ? "✕" : "☰"}</span>
            </button>
          </div>
        </div>

        {menuOpen && (
          <nav className="site-menu" id="site-menu" aria-label="Primary, mobile">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to}>
                {item.label}
              </NavLink>
            ))}
            {/* The account links live in the nav bar on desktop, where there is
                room; on a phone the bar holds only Play, so they belong here. */}
            {me === null ? (
              <NavLink to="/sign-in">Sign in</NavLink>
            ) : (
              <>
                <NavLink to="/profile">{me.account.callsign}</NavLink>
                <NavLink to="/character">Character</NavLink>
              </>
            )}
          </nav>
        )}
      </header>

      <main id="main">
        <Outlet />
      </main>

      <footer className="site-footer">
        <div className="shell">
          <p className="site-footer-legal">{BRAND.legal}</p>
          <div className="site-footer-meta">
            <span>{BRAND.copyright}</span>
            <Link to="/faq">FAQ</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
