// Character appearance and loadout: the shapes, the defaults, and validation.
//
// Pure and shared. The client uses it to build the editor and to disable options
// the account has not unlocked; the server uses the SAME function to validate what
// gets saved, because a client that can pick an option is not evidence that the
// option is allowed — the request is what has to be checked.
//
// Unlock gating reads src/account/tiers.ts. Nothing here may affect concealment,
// ballistics or visibility: appearance is cosmetic, and the loadout picks from
// weapons the game already defines rather than tuning them.

import { can, type TierId } from "./tiers.ts";
import { WEAPON_DEFINITIONS } from "../fps/weapons/weaponDefinitions.ts";

/**
 * Every weapon id the engine defines.
 *
 * Imported rather than restated so a typo in the selectable lists below is a
 * compile error instead of a loadout that silently falls back to the default.
 * `weaponDefinitions.ts` and its ammunition table import types only, so pulling
 * them in here does not drag Three.js into the server or the site bundle — worth
 * checking again if that ever changes.
 */
export type WeaponId = (typeof WEAPON_DEFINITIONS)[number]["id"];

export type Faction = "ranger" | "opfor";

/** Camouflage patterns. Cosmetic only — none of these alter concealment. */
export const CAMOS = ["woodland", "desert", "urban", "winter", "tiger"] as const;
export type Camo = (typeof CAMOS)[number];

/** Headgear. Cosmetic only. */
export const HEADGEAR = ["boonie", "helmet", "cap", "bare"] as const;
export type Headgear = (typeof HEADGEAR)[number];

export interface CharacterAppearance {
  faction: Faction;
  camo: Camo;
  headgear: Headgear;
  /**
   * Clan insignia, or null. Gated on `customInsignia`, which is a supporter
   * capability — the one appearance field that is not free.
   */
  insignia: string | null;
}

export interface CharacterLoadout {
  primary: WeaponId;
  secondary: WeaponId;
}

export interface Character {
  appearance: CharacterAppearance;
  loadout: CharacterLoadout;
}

/**
 * Weapon ids a character may select.
 *
 * Explicit lists rather than "every id in WEAPON_DEFINITIONS", because the weapon
 * table includes development entries — `saw-test` is exactly that — and
 * "everything the engine can fire" is not the same set as "everything a player may
 * equip". The type annotation is what keeps these honest against the real table.
 */
export const SELECTABLE_PRIMARY: readonly WeaponId[] = ["prototype-sniper", "m4"];
export const SELECTABLE_SECONDARY: readonly WeaponId[] = ["glock-9mm"];

/**
 * What to call a weapon on screen.
 *
 * Read from the engine's own table rather than restated beside the editor: the
 * HUD already shows `displayName`, so a second list of names means the same rifle
 * is called two different things depending on which screen the player is looking
 * at, and neither one is wrong enough to notice.
 */
export function weaponLabel(id: WeaponId): string {
  return WEAPON_DEFINITIONS.find((weapon) => weapon.id === id)?.displayName ?? id;
}

export const DEFAULT_CHARACTER: Character = {
  appearance: { faction: "ranger", camo: "woodland", headgear: "boonie", insignia: null },
  // The bolt gun by default: it is the weapon this game is built around, and the
  // first thing a new player should be holding when they look at the grass.
  loadout: { primary: "prototype-sniper", secondary: "glock-9mm" },
};

/** Longest an insignia string may be. Kept short: it renders on a shoulder patch. */
export const INSIGNIA_MAX = 4;

export interface CharacterProblem {
  field: string;
  message: string;
}

/**
 * Validate an untrusted character against what this tier may equip.
 *
 * Returns the problems rather than throwing, so a form can show all of them at
 * once instead of one per submit. An empty array means the character is safe to
 * store. The `tier` argument is what makes this a GATE and not just a shape
 * check — call it with the account's effective tier, never with the tier the
 * request claims.
 */
export function validateCharacter(value: unknown, tier: TierId): CharacterProblem[] {
  const problems: CharacterProblem[] = [];
  if (typeof value !== "object" || value === null) {
    return [{ field: "character", message: "Expected an object." }];
  }
  const character = value as Partial<Character>;
  const appearance = character.appearance;
  const loadout = character.loadout;

  if (typeof appearance !== "object" || appearance === null) {
    problems.push({ field: "appearance", message: "Missing appearance." });
  } else {
    if (appearance.faction !== "ranger" && appearance.faction !== "opfor") {
      problems.push({ field: "appearance.faction", message: "Unknown faction." });
    }
    if (!CAMOS.includes(appearance.camo as Camo)) {
      problems.push({ field: "appearance.camo", message: "Unknown camo." });
    }
    if (!HEADGEAR.includes(appearance.headgear as Headgear)) {
      problems.push({ field: "appearance.headgear", message: "Unknown headgear." });
    }
    const insignia = appearance.insignia;
    if (insignia !== null && insignia !== undefined) {
      if (typeof insignia !== "string" || !/^[A-Z0-9]{1,4}$/.test(insignia)) {
        problems.push({
          field: "appearance.insignia",
          message: `Up to ${INSIGNIA_MAX} capital letters or digits.`,
        });
      } else if (!can(tier, "customInsignia")) {
        // The gate, and the reason this function takes a tier at all. A client
        // build with the control enabled must still be refused here.
        problems.push({
          field: "appearance.insignia",
          message: "Custom insignia is a supporter perk.",
        });
      }
    }
  }

  if (typeof loadout !== "object" || loadout === null) {
    problems.push({ field: "loadout", message: "Missing loadout." });
  } else {
    if (!SELECTABLE_PRIMARY.includes(loadout.primary as WeaponId)) {
      problems.push({ field: "loadout.primary", message: "Not a selectable primary." });
    }
    if (!SELECTABLE_SECONDARY.includes(loadout.secondary as WeaponId)) {
      problems.push({ field: "loadout.secondary", message: "Not a selectable secondary." });
    }
    if (!can(tier, "savedLoadouts")) {
      // Guests may play with the default loadout but not persist a different one.
      const isDefault =
        loadout.primary === DEFAULT_CHARACTER.loadout.primary &&
        loadout.secondary === DEFAULT_CHARACTER.loadout.secondary;
      if (!isDefault) {
        problems.push({
          field: "loadout",
          message: "Saving a loadout needs an account.",
        });
      }
    }
  }

  return problems;
}

/**
 * Coerce whatever is in storage into a usable character.
 *
 * Stored JSON predates any field added later, and a profile page that throws on
 * an old row is worse than one that shows a default sleeve. Unknown values fall
 * back per field rather than discarding the whole record — losing someone's camo
 * because a later build renamed a headgear option would be a bad trade.
 */
export function coerceCharacter(value: unknown): Character {
  const source = (typeof value === "object" && value !== null ? value : {}) as Partial<Character>;
  const appearance = (source.appearance ?? {}) as Partial<CharacterAppearance>;
  const loadout = (source.loadout ?? {}) as Partial<CharacterLoadout>;
  const insignia =
    typeof appearance.insignia === "string" && /^[A-Z0-9]{1,4}$/.test(appearance.insignia)
      ? appearance.insignia
      : null;
  return {
    appearance: {
      faction: appearance.faction === "opfor" ? "opfor" : "ranger",
      camo: CAMOS.includes(appearance.camo as Camo)
        ? (appearance.camo as Camo)
        : DEFAULT_CHARACTER.appearance.camo,
      headgear: HEADGEAR.includes(appearance.headgear as Headgear)
        ? (appearance.headgear as Headgear)
        : DEFAULT_CHARACTER.appearance.headgear,
      insignia,
    },
    loadout: {
      primary: SELECTABLE_PRIMARY.includes(loadout.primary as WeaponId)
        ? loadout.primary!
        : DEFAULT_CHARACTER.loadout.primary,
      secondary: SELECTABLE_SECONDARY.includes(loadout.secondary as WeaponId)
        ? loadout.secondary!
        : DEFAULT_CHARACTER.loadout.secondary,
    },
  };
}
