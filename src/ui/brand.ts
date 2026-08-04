// Distant Front — the one place product-facing strings live.
//
// Every page title, meta tag, email subject and footer disclaimer reads from
// here, so the brand is one edit rather than a grep. The legal line is not
// decoration: docs/01 §3 requires a public surface to be explicit that this is
// fan-led and unaffiliated, and a constant is how that survives a copy rewrite.

export const BRAND = {
  name: "Distant Front",
  /** Shown under the wordmark. Deliberately not a trademark claim on DF. */
  tagline: "A spiritual successor to Delta Force",
  /**
   * One sentence, used for meta description and social cards. Written to say
   * what the game IS rather than what it is a successor to, because a search
   * result that leads with someone else's title reads as a clone.
   */
  blurb:
    "A long-range tactical shooter in the browser. Vast terrain, grass that " +
    "actually conceals you, and engagements measured in hundreds of metres.",
  /**
   * The hero's own version of the blurb.
   *
   * Separate from `blurb` because the hero already says "playable in your
   * browser" in its eyebrow, and the meta description needs that phrase for
   * search while the hero would only repeat itself with it.
   */
  heroLede:
    "Vast terrain, grass that actually conceals you, and engagements measured " +
    "in hundreds of metres. Built by modders from the original Delta Force " +
    "community, on a renderer written for the web.",
  /**
   * Required on every public page. docs/01 §3 — the product must not imply
   * endorsement, and the name deliberately avoids the trademark.
   */
  legal:
    "An independent, fan-led reconstruction. Not affiliated with, endorsed by, " +
    "or connected to NovaLogic or the current Delta Force rights holders.",
  copyright: "© 2026 Distant Front",
} as const;

/** Document title for a page. Falls back to the tagline on the landing route. */
export function pageTitle(section?: string): string {
  return section ? `${section} — ${BRAND.name}` : `${BRAND.name} — ${BRAND.tagline}`;
}
