// 404 — kept short, and it offers the two things a lost visitor actually wants.
//
// Worth noting for deployment: this only renders for paths the router does not
// know. A static host must be configured to serve index.html for unknown paths
// or the server's own 404 wins and this page is never reached (netlify.toml
// already has that rewrite).

import { Link } from "react-router";
import { useDocumentTitle } from "../useDocumentTitle";
import "./page.css";

export function NotFound() {
  useDocumentTitle("Not found");

  return (
    <div className="shell notfound">
      <p className="eyebrow">Error 404</p>
      <h1 className="display display-lg">No contact at that grid.</h1>
      <p className="prose">That page does not exist, or it moved.</p>
      <div className="row" style={{ justifyContent: "center" }}>
        <Link className="btn btn-primary" to="/play">
          Play now
        </Link>
        <Link className="btn btn-ghost" to="/">
          Back to base
        </Link>
      </div>
    </div>
  );
}
