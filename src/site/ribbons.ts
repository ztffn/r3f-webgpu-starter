// Service ribbons, drawn from a medal id.
//
// The rack is the profile's signature element and it needs no image files: a
// ribbon is a 3:1 rectangle of vertical stripes, which is exactly a CSS linear
// gradient with hard stops. Each medal gets a deterministic pattern derived from
// its id, so the same medal is always the same ribbon on every screen and adding
// one to the catalogue needs no art.
//
// Presentation only. The catalogue itself is src/account/medals.ts.

/**
 * Ribbon colours.
 *
 * Deliberately NOT the site palette: real ribbons are saturated, and the page's
 * parchment and olive would make nine medals look like nine identical beige
 * bars. This is the one place on the site that gets its own colours, which is
 * what makes the rack the thing the eye goes to.
 */
const THREADS = [
  "#7d2231", // crimson
  "#1f3a63", // navy
  "#2f5136", // forest
  "#c8a032", // gold
  "#d8d3c4", // bone
  "#3d3f45", // gunmetal
  "#8a5c22", // bronze
  "#5c2f66", // purple
  "#1c1d1f", // black
  "#a8471f", // rust
];

/** FNV-1a. Small, stable, and enough to spread nine ids across the palette. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A `background-image` value: vertical stripes, mirrored about the centre.
 *
 * Mirrored because real ribbons are symmetrical, and an asymmetric one reads as
 * a mistake even to someone who has never looked at a rack closely.
 */
export function ribbonStyle(medalId: string): { backgroundImage: string } {
  const seed = hash(medalId);
  // UNSIGNED shifts throughout. `>>` is signed, so any hash above 2^31 shifted
  // right stays negative, a negative modulo returns a negative index, and
  // `THREADS[-3]` is `undefined` — which produced a gradient string containing
  // the literal text "undefined" that the browser rejected wholesale, leaving
  // every ribbon transparent. The same negative modulo also made the centre
  // stripe's end land before its start.
  const field = THREADS[seed % THREADS.length]!;
  const edge = THREADS[(seed >>> 4) % THREADS.length]!;
  const centre = THREADS[(seed >>> 9) % THREADS.length]!;
  // Two stripe widths, so the nine medals do not all share one rhythm.
  const edgeWidth = 8 + ((seed >>> 14) % 4) * 2;
  const centreWidth = 6 + ((seed >>> 18) % 5) * 3;

  const half = 50 - centreWidth / 2;
  const stops = [
    `${edge} 0 ${edgeWidth}%`,
    `${field} ${edgeWidth}% ${half}%`,
    `${centre} ${half}% ${half + centreWidth}%`,
    `${field} ${half + centreWidth}% ${100 - edgeWidth}%`,
    `${edge} ${100 - edgeWidth}% 100%`,
  ].join(", ");
  return { backgroundImage: `linear-gradient(90deg, ${stops})` };
}
