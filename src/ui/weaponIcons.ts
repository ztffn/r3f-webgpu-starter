// Weapon silhouettes for the HUD and the loadout screen.
//
// Authored renders in public/assets/ui/weapons/, greyscale on transparency. They
// are used as CSS MASKS rather than as images, so each one paints in whatever
// colour its context sets — the HUD gets phosphor olive and the loadout screen
// gets its own ink from the same file, with no per-surface copy of the asset.
//
// Skin-agnostic and import-free, so both src/hud/ and src/site/ may use it.

import type { WeaponId } from "../account/characters";

const BASE = "/assets/ui/weapons";

/**
 * Weapon id to silhouette.
 *
 * Not every weapon has one, and a missing entry renders NO icon rather than a
 * stand-in: showing a submachine gun beside "Glock" would be a picture of the
 * wrong object, which is worse than a name on its own. `ak`, `smg`, `knife` and
 * `gnade` are drawn and unused, waiting on the weapons that need them.
 * `pistol_icon` is authored from an SVG profile (2026-08-05), same greyscale
 * mask treatment as the renders; the aspect differs and that is fine —
 * `mask-size: contain` normalises every icon to its box anyway.
 */
const ICONS: Partial<Record<WeaponId, string>> = {
  "prototype-sniper": `${BASE}/m40_icon.webp`,
  m4: `${BASE}/m4_icon.webp`,
  "saw-test": `${BASE}/lmg_icon.webp`,
  "glock-9mm": `${BASE}/pistol_icon.webp`,
};

export function weaponIcon(id: WeaponId): string | null {
  return ICONS[id] ?? null;
}

/**
 * The inline style that paints a silhouette.
 *
 * `currentColor` is the whole point: the element inherits the colour of the
 * panel it sits in, so one asset serves the olive HUD and the parchment site
 * without a second file or a filter chain. The `-webkit-` pair is still required
 * for Safari, which has not unprefixed mask-image.
 */
export function weaponIconStyle(id: WeaponId): Record<string, string> | undefined {
  const url = weaponIcon(id);
  if (url === null) return undefined;
  return { "--weapon-icon": `url("${url}")` };
}
