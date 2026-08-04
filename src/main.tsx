import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import "./ui/tokens.css";
import "./ui/primitives.css";
import { AuthProvider } from "./account/AuthProvider";
import { router } from "./site/routes";

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

// Only the token and primitive stylesheets are global. The game's own CSS travels
// with its lazily-imported chunk (src/game/GameApp.tsx), so a visitor who never
// opens /play never downloads it — which is the whole point of the route split.
// AuthProvider wraps the router rather than sitting inside a layout, so the
// account is fetched once per page load and every route — including /play — sees
// the same state.
createRoot(container).render(
  <AuthProvider>
    <RouterProvider router={router} />
  </AuthProvider>
);
