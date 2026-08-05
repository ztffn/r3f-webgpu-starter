// Route table for the whole product — public site and the playable game.
//
// The one rule that matters here: /play is a React.lazy boundary, so the Three.js
// tree is fetched only when somebody actually plays. Every other route must stay
// statically imported and game-free, or the split silently stops working.
// Legacy dev URLs (`/?scene=scope&motor=1`) are redirected to /play with their
// query string intact, because docs 08/10/12 and PLAYING.md all cite them.

import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, useLocation } from "react-router";
import {
  loadGameApp,
  LOADOUT_STOP_URL,
  ROOT_REDIRECT_PARAMS,
  shouldStopAtLoadout,
} from "../ui/launchParams";
import { SiteLayout } from "./SiteLayout";
import { Landing } from "./pages/Landing";
import { Faq } from "./pages/Faq";
import { Supporter } from "./pages/Supporter";
import { Lobby } from "./pages/Lobby";
import { Leaderboard } from "./pages/Leaderboard";
import { SignIn } from "./pages/SignIn";
import { Register } from "./pages/Register";
import { Profile } from "./pages/Profile";
import { CharacterPage } from "./pages/CharacterPage";
import { PlayerProfile } from "./pages/PlayerProfile";
import { Clans, ClanPage } from "./pages/Clans";
import { Standings } from "./pages/Standings";
import { Arsenal, Maps } from "./pages/Arsenal";
import { Compare } from "./pages/Compare";
import { NotFound } from "./pages/NotFound";
import { Booting } from "./Booting";

const GameApp = lazy(loadGameApp);

/**
 * The landing page, unless the URL is one of the documented dev URLs.
 *
 * Those all predate the router and are cited throughout docs/ and PLAYING.md, so
 * they keep working: the redirect preserves the search string exactly, and /play
 * is the canonical form going forward. The parameter list lives in
 * launchParams.ts (a list rather than a catch-all, so an ordinary marketing link
 * with a `?utm_source=` on it still lands on the landing page).
 */
function LandingOrGame() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  if (ROOT_REDIRECT_PARAMS.some((key) => params.has(key))) {
    return <Navigate to={{ pathname: "/play", search: location.search }} replace />;
  }
  return <Landing />;
}

/**
 * The game route. Outside SiteLayout — no nav or footer over a live scene.
 *
 * A BARE /play is the site funnel, and the funnel stops at the loadout screen
 * first — the one with the soldier — which counts down and comes back here as
 * `/play?loadout=0`. The handshake's rules live in launchParams.ts beside the
 * parameter vocabulary they depend on.
 */
function Play() {
  const location = useLocation();
  if (shouldStopAtLoadout(new URLSearchParams(location.search))) {
    return <Navigate to={LOADOUT_STOP_URL} replace />;
  }
  return (
    <Suspense fallback={<Booting />}>
      <GameApp />
    </Suspense>
  );
}

/**
 * Dev-only routes.
 *
 * The `lazy(() => import(...))` has to sit INSIDE the branch, not at module
 * scope. `import.meta.env.DEV` is statically replaced with `false` in a production
 * build, so a dead branch is dropped — but a top-level dynamic import is reachable
 * regardless of who calls it, and Rollup emitted the HudLab chunk into `dist/`
 * anyway. Verified by grepping the build output, not assumed.
 */
const DEV_ROUTES = import.meta.env.DEV
  ? [
      {
        path: "/hudlab",
        element: (() => {
          const HudLab = lazy(() => import("../hud/HudLab"));
          return (
            <Suspense fallback={<Booting label="Loading HUD lab" />}>
              <HudLab />
            </Suspense>
          );
        })(),
      },
    ]
  : [];

export const router = createBrowserRouter([
  { path: "/play", element: <Play /> },
  ...DEV_ROUTES,
  {
    path: "/",
    element: <SiteLayout />,
    children: [
      { index: true, element: <LandingOrGame /> },
      { path: "faq", element: <Faq /> },
      { path: "supporter", element: <Supporter /> },
      { path: "lobby", element: <Lobby /> },
      // The board is the stats one now; the old single-stat boards live on at
      // /records so the honest empty states they carry are not lost.
      { path: "leaderboard", element: <Standings /> },
      { path: "records", element: <Leaderboard /> },
      { path: "weapons", element: <Arsenal /> },
      { path: "maps", element: <Maps /> },
      { path: "compare", element: <Compare /> },
      { path: "sign-in", element: <SignIn /> },
      { path: "register", element: <Register /> },
      // No route guard: both pages render their own signed-out state with a way
      // in. A redirect would be worse — it loses the URL someone was sent, and a
      // guard that runs before /api/me settles bounces a signed-in visitor.
      { path: "profile", element: <Profile /> },
      { path: "character", element: <CharacterPage /> },
      // The community layer. `players/:id` is the hub every callsign links to.
      { path: "players/:id", element: <PlayerProfile /> },
      { path: "clans", element: <Clans /> },
      { path: "clans/:tag", element: <ClanPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
