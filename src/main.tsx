import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import "./ui/tokens.css";
import "./ui/primitives.css";
import { router } from "./site/routes";

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

// Only the token and primitive stylesheets are global. The game's own CSS travels
// with its lazily-imported chunk (src/game/GameApp.tsx), so a visitor who never
// opens /play never downloads it — which is the whole point of the route split.
createRoot(container).render(<RouterProvider router={router} />);
