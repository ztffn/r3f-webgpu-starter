// Loading state shown while the game chunk downloads.
//
// Deliberately styled as the game's own boot screen rather than the site's, so
// crossing from /supporter into /play reads as one continuous transition instead
// of a blank frame followed by a different-looking one. Reused as the Suspense
// fallback for every lazy route that pulls the renderer.

import { BRAND } from "../ui/brand";

export function Booting({ label = "Loading" }: { label?: string }) {
  return (
    <div className="booting" role="status" aria-live="polite">
      <span className="booting-brand">{BRAND.name}</span>
      <span className="booting-label">{label}</span>
      <span className="booting-bar" aria-hidden="true">
        <i />
      </span>
    </div>
  );
}
