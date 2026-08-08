// Maps a gameplay weapon id onto the authored first-person rig: which weapon GLB to
// load, and which NAMED animation clip each gameplay event plays.
//
// Pure data and pure functions — no Three.js and no loading — so the mapping and the
// clip-name construction stay testable without a renderer. The rig that drives two
// mixers from this lives in FirstPersonWeaponRig.ts.

/**
 * The ten weapon keys the authored rig ships. The key is the filename stem, the weapon
 * clip namespace, and half of every hand clip name, so it is not a display concern.
 */
export const RIG_WEAPON_KEYS = [
  "carbine",
  "ak",
  "sniper",
  "lmg",
  "smg",
  "pistol",
  "grenadelauncher",
  "knife",
  "shotgun",
  "fiftycal",
] as const;

export type RigWeaponKey = (typeof RIG_WEAPON_KEYS)[number];

/**
 * Gameplay event to authored clip name.
 *
 * An ABSENT key means the rig has no authored clip for that event, and the caller must
 * play nothing rather than substitute something that reads as a different action. The
 * proxy rig had a dry-fire segment; this rig has no dry-fire animation at all, and a
 * reload standing in for one would be a lie the player can see.
 */
export interface WeaponPresentationSegments {
  readonly idle: string;
  readonly draw: string;
  readonly holster: string;
  readonly fire?: string;
  /** Absent on the shotgun, whose reload clips were never exported on the weapon side. */
  readonly reload?: string;
  readonly melee?: string;
  /** Sniper only: the state machine may play this after `fire` when ammo allows. */
  readonly chamber?: string;
  readonly dryFire?: string;
}

export interface WeaponPresentationDefinition {
  readonly rigKey: RigWeaponKey;
  readonly developmentLabel: string;
  readonly segments: WeaponPresentationSegments;
}

/**
 * What each rig weapon can actually play, keyed by rig weapon rather than by game weapon.
 *
 * Keyed this way because the model owns its vocabulary: the shotgun's whole pump-and-shell
 * reload and the LMG's alternate reload exist in the hands but were never exported on the
 * weapon side, and the knife has no ranged attack at all. An absent entry means the rig has
 * no clip for that event and the caller must play NOTHING — substituting a stand-in shows
 * the player an action they did not take.
 */
const RIG_SEGMENTS: Readonly<Record<RigWeaponKey, WeaponPresentationSegments>> = {
  // Both a tactical and a from-empty reload; gameplay models one, so it takes the full
  // one. Worth knowing before trusting the names: on the carbine `reload_fast` (2.30 s) is
  // fractionally LONGER than `reload_slow` (2.20 s), and the notes admit the split was
  // inferred from timing rather than authored. Re-derive from the animation, not the name.
  carbine: { idle: "idle", fire: "shoot", reload: "reload_slow", draw: "weapon_up", holster: "weapon_down", melee: "melee" },
  ak: { idle: "idle", fire: "shoot", reload: "reload_slow", draw: "weapon_up", holster: "weapon_down", melee: "melee" },
  smg: { idle: "idle", fire: "shoot", reload: "reload_slow", draw: "weapon_up", holster: "weapon_down", melee: "melee" },
  pistol: { idle: "idle", fire: "shoot", reload: "reload_slow", draw: "weapon_up", holster: "weapon_down", melee: "melee" },
  fiftycal: { idle: "idle", fire: "shoot", reload: "reload_slow", draw: "weapon_up", holster: "weapon_down", melee: "melee" },
  // One reload clip each.
  sniper: { idle: "idle", fire: "shoot", reload: "reload", draw: "weapon_up", holster: "weapon_down", melee: "melee", chamber: "chamber_round" },
  lmg: { idle: "idle", fire: "shoot", reload: "reload", draw: "weapon_up", holster: "weapon_down", melee: "melee" },
  grenadelauncher: { idle: "idle", fire: "shoot", reload: "reload", draw: "weapon_up", holster: "weapon_down", melee: "melee" },
  // NO reload: `pump`, `reload_single_shell` and `reload_complete` are in the hands and
  // absent from shotgun.glb. Naming one here would fail the load-time clip assertion.
  shotgun: { idle: "idle", fire: "shoot", draw: "weapon_up", holster: "weapon_down", melee: "melee" },
  // A melee weapon: its attacks stand in for firing, and it has no `melee` clip of its own.
  knife: { idle: "idle", fire: "attack_slice1", draw: "weapon_up", holster: "weapon_down", melee: "attack_stab1" },
};

const RIG_LABELS: Readonly<Record<RigWeaponKey, string>> = {
  carbine: "CARBINE",
  ak: "AK",
  sniper: "SNIPER",
  lmg: "LMG",
  smg: "SMG",
  pistol: "PISTOL",
  grenadelauncher: "GRENADE LAUNCHER",
  knife: "KNIFE",
  shotgun: "SHOTGUN",
  fiftycal: ".50 CAL",
};

/**
 * A presentation for any rig weapon, including the six no game weapon maps to.
 *
 * Those six have no gameplay definition and are unreachable in normal play; this exists so
 * the dev console's debug keys can put them on screen to be posed and inspected.
 */
export function presentationForRigKey(rigKey: RigWeaponKey): WeaponPresentationDefinition {
  return { rigKey, developmentLabel: RIG_LABELS[rigKey], segments: RIG_SEGMENTS[rigKey] };
}

/**
 * Gameplay weapon id to rig weapon.
 *
 * The rig carries ten weapons and the game defines four, so this is a decision rather
 * than a lookup. Each of the four picks the rig weapon that matches its class AND keeps
 * one of the three aiming paths represented: the sniper is the rig's only magnified
 * optic and holds the picture-in-picture scope path open, the carbine is its only
 * assault rifle and carries the authored emissive red-dot lens, while the pistol and
 * LMG have no optic node at all and are therefore the iron-sight cases.
 */
const PRESENTATIONS: Readonly<Record<string, WeaponPresentationDefinition>> = {
  "prototype-sniper": presentationForRigKey("sniper"),
  m4: presentationForRigKey("carbine"),
  "glock-9mm": presentationForRigKey("pistol"),
  "saw-test": presentationForRigKey("lmg"),
};

const FALLBACK = PRESENTATIONS.m4;

/** GLTF and animation selection stays on the presentation side of the boundary. */
export function weaponPresentationFor(weaponId: string): WeaponPresentationDefinition {
  // Own-property only: an inherited key such as "constructor" would otherwise
  // resolve to a function instead of falling back to a real definition.
  return Object.hasOwn(PRESENTATIONS, weaponId) ? PRESENTATIONS[weaponId] : FALLBACK;
}

/**
 * The hands clip for one weapon's segment.
 *
 * Hand clips are namespaced per weapon (`hand_sniper_shoot`) while weapon clips are not
 * (`shoot`), because each weapon GLB is already scoped to one weapon. That asymmetry is
 * the authored convention, not an accident, so it is expressed once here.
 */
export function handClipName(rigKey: RigWeaponKey, segment: string): string {
  return `hand_${rigKey}_${segment}`;
}

/** Every hand clip a given weapon can ask for, for load-time validation. */
export function handClipNamesFor(definition: WeaponPresentationDefinition): string[] {
  return weaponClipNamesFor(definition).map((segment) => handClipName(definition.rigKey, segment));
}

/** Every weapon clip a given weapon can ask for, for load-time validation. */
export function weaponClipNamesFor(definition: WeaponPresentationDefinition): string[] {
  // Absent segments are dropped, not stringified. Naming a clip the weapon never exported
  // fails the load-time assertion in fpRigAssets and takes the whole weapon down with it.
  return [...new Set(Object.values(definition.segments).filter((name): name is string => !!name))];
}
