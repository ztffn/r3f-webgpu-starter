// First-person weapon FEEL: per-weapon placement at the hip, sprinting and aiming, plus
// the global movement bob. One mutable singleton so the dev console can tune it live.
//
// Per WEAPON rather than one global pair, because the authored models differ: the sniper
// carries a 42 cm scope, the pistol is a third the length, and one offset that suits both
// suits neither. Defaults live here as plain numbers and are what a tuning session edits;
// `serialize()` prints the table back out so a session's work survives as source.

import { RIG_WEAPON_KEYS, type RigWeaponKey } from "./WeaponPresentationDefinition.ts";
import {
  DEFAULT_WEAPON_BOB,
  type WeaponBobConfig,
  type WeaponBobGait,
} from "./WeaponBob.ts";
/**
 * Tuning persists in localStorage, NOT sessionStorage.
 *
 * The difference is the whole reason this comment exists. sessionStorage is scoped to one
 * TAB and is discarded the moment that tab closes — it survives a reload and nothing else,
 * so closing the tab, opening a second one, or restarting the browser silently drops a
 * tuning session back to the baked defaults and looks exactly like the values being
 * overwritten. Dialling a weapon in is hours of work across sittings; it outlives a tab.
 *
 * Guarded because touching either store throws outright when cookies are blocked, and
 * these run inside a constructor.
 */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do and nothing worth saying: the tuning simply does not persist.
  }
}

/**
 * One placement: where the rig sits and how it is turned, relative to the eye.
 *
 * Position is metres, +x right, +y up, -z forward. Rotation is DEGREES — stored that way
 * because these numbers are read and typed by a person on a slider and pasted back as
 * source, and radians would make every one of them unreadable. Converted at use.
 *
 * `pitch` is the tilt an iron sight needs: the authored models point the barrel level,
 * and lining up a rear notch means nosing the weapon down toward the eye.
 */
export interface PosePlacement {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
}

export interface WeaponPose {
  hip: PosePlacement;
  /**
   * Placement while sprinting.
   *
   * A real sprint pose is mostly ROTATION — the weapon cants over, turns off centre and
   * noses down as the arms drive — which is why this arrived only once the dials carried
   * angles. Sprinting already refuses the shot outright (docs/10 §10), so this pose never
   * has to remain a firing position.
   */
  sprint: PosePlacement;
  /**
   * Placement for ADS.
   *
   * The POSITION means two different things depending on the weapon, which is why it is
   * one field rather than two. With an optic it is EYE RELIEF — a nudge applied after the
   * glass has been aligned to the eye, so z is how far behind the lens the eye sits.
   * Without one it is the whole placeholder raise, because there is no anchor to align to.
   * Rotation means the same thing either way.
   */
  ads: PosePlacement;
}

/**
 * How long a weapon takes to come up and to come down, in seconds.
 *
 * The same shape as `WeaponDefinition["ads"]`, and deliberately so — the panel prints it
 * back out to be pasted into `weaponDefinitions.ts`, which is where it belongs.
 */
export interface AdsTiming {
  enterSeconds: number;
  exitSeconds: number;
}

/** Positional axes only, for the places that lerp or copy them without the angles. */
export const POSE_MODES = ["hip", "sprint", "ads"] as const;
export type PoseMode = (typeof POSE_MODES)[number];
export const POSE_AXES = ["x", "y", "z"] as const;
export const POSE_ANGLES = ["pitch", "yaw", "roll"] as const;

/** Angles default to zero so an untilted weapon reads as three numbers, not six. */
function place(x: number, y: number, z: number, pitch = 0, yaw = 0, roll = 0): PosePlacement {
  return { x, y, z, pitch, yaw, roll };
}

/**
 * Shipped defaults.
 *
 * Tuned in the browser, not guessed, for the weapons the game maps: the proxy's single
 * offset was set against a model scaled 3x with a different internal origin, and carried
 * over it put the hands below the bottom of the frame. The rest are seeded from their
 * closest tuned neighbour and are UNTUNED — no gameplay definition maps to them, so
 * nothing has ever rendered them.
 */
const DEFAULT_POSES: Record<RigWeaponKey, WeaponPose> = {
  // Tuned in the browser through the Weapon pose tab. The four the game maps are dialled;
  // the rest still carry placeholder numbers and are reachable on the debug keys below.
  carbine: { hip: place(0.1, -0.27, -0.385, 0, 0, 5), sprint: place(0.195, -0.225, -0.48, -9.5, 8, 9), ads: place(0, 0, -0.125) },
  pistol: { hip: place(0.1, -0.225, -0.3), sprint: place(0.245, -0.19, -0.42, -11, 8.5, -4), ads: place(0, -0.19, -0.2, -0.5) },
  sniper: { hip: place(0.1, -0.22, -0.395, -0.5, -1.5), sprint: place(0.245, -0.145, -0.42, -21, 13.5, 15.5), ads: place(0, 0, -0.075) },
  lmg: { hip: place(0.1, -0.265, -0.45, -1.5, -0.5, 1), sprint: place(0.1, -0.265, -0.165, -10, 21.5, 24.5), ads: place(0, -0.25, -0.17, 1) },
  ak: { hip: place(0.1, -0.2, -0.42), sprint: place(0.1, -0.27, -0.385), ads: place(0, -0.11, -0.2) },
  smg: { hip: place(0.1, -0.2, -0.42), sprint: place(0.1, -0.27, -0.385), ads: place(0, -0.11, -0.2) },
  shotgun: { hip: place(0.1, -0.2, -0.42), sprint: place(0.1, -0.27, -0.385), ads: place(0, -0.11, -0.2) },
  fiftycal: { hip: place(0.1, -0.2, -0.42), sprint: place(0.1, -0.2, -0.42), ads: place(0, -0.11, -0.2) },
  grenadelauncher: { hip: place(0.1, -0.2, -0.42), sprint: place(0.1, -0.2, -0.42), ads: place(0, 0, -0.075) },
  knife: { hip: place(0.1, -0.2, -0.42), sprint: place(0.1, -0.2, -0.42), ads: place(0, -0.11, -0.2) },
};

const POSE_KEY = "df2.weaponPoses.v2";
/**
 * Bumped from v2 with the authored/override split below.
 *
 * A v2 blob is not readable as v3 and must not be: it was written by serialising ONE map
 * that held both seeded and tuned values, so every weapon the browser had merely equipped
 * appears in it. Read as v3 those would all become deliberate overrides, which is the
 * exact failure the split exists to end.
 */
const ADS_KEY = "df2.weaponAdsTiming.v3";
const BOB_KEY = "df2.weaponBob.v3";

/**
 * Per-weapon bob overrides. SPARSE — anything absent uses the shared sourced defaults.
 *
 * Paste tuned weapons here from the dev console. Only what genuinely differs belongs in
 * this table; ten near-identical full configs would rot the moment the shared defaults
 * moved, because nobody would remember to update the nine that were only copies.
 */
const BOB_BY_WEAPON: Partial<Record<RigWeaponKey, WeaponBobConfig>> = {};

function clonePoses(): Record<RigWeaponKey, WeaponPose> {
  const out = {} as Record<RigWeaponKey, WeaponPose>;
  for (const [key, pose] of Object.entries(DEFAULT_POSES)) {
    out[key as RigWeaponKey] = {
      hip: { ...pose.hip },
      sprint: { ...pose.sprint },
      ads: { ...pose.ads },
    };
  }
  return out;
}

/**
 * Restore a tuning session.
 *
 * Persisted because the loop is otherwise unusable: terrain decode costs roughly half a
 * minute, so a reload that discarded the dials would make every reload a restart. Only
 * keys and axes that already exist are copied in, so a stale entry from a renamed weapon
 * is ignored rather than widening the table.
 */
function restore(poses: Record<RigWeaponKey, WeaponPose>): void {
  const raw = readStored(POSE_KEY);
  if (!raw) return;
  try {
    const stored = JSON.parse(raw) as Partial<Record<RigWeaponKey, WeaponPose>>;
    for (const [key, pose] of Object.entries(stored)) {
      const target = poses[key as RigWeaponKey];
      if (!target || !pose) continue;
      for (const mode of POSE_MODES) {
        for (const field of [...POSE_AXES, ...POSE_ANGLES]) {
          const value = pose[mode]?.[field];
          if (typeof value === "number" && Number.isFinite(value)) target[mode][field] = value;
        }
      }
    }
  } catch {
    // A corrupt entry is not worth failing the scene over; the defaults are correct.
  }
}

class WeaponPoseStore {
  private readonly poses = clonePoses();

  /** The rig weapon currently equipped, so the panel tunes what is on screen. */
  equipped: RigWeaponKey | null = null;

  /** Whether the equipped weapon resolved an optic, which changes what `ads` means. */
  equippedHasOptic = false;

  /**
   * Hold ADS regardless of input.
   *
   * Tuning the aimed pose otherwise needs pointer lock held with one hand while dragging
   * a slider with the other, and releasing the pointer to reach the console drops ADS.
   */
  forceAds = false;

  /** Hold the sprint pose regardless of the motor, for the same tuning reason. */
  forceSprint = false;

  /**
   * What `weaponDefinitions.ts` currently authors. Refreshed every frame the weapon is
   * equipped, and NEVER persisted.
   *
   * Held apart from the override below, and the separation is a fix rather than a tidy.
   * When one map served both, a stored value won at construction and the seed declined to
   * overwrite it — so editing the authored number in source did nothing, for ever, on the
   * one machine that had tuned that weapon, with nothing on screen saying why and no way
   * to clear it. These are GAMEPLAY values: `adsProgress` drives sway and pointer
   * sensitivity, not just where the model sits. The pose and bob tables never had this
   * problem because they always knew their shipped value and could therefore offer a
   * reset; this now does too.
   */
  private readonly adsAuthored = new Map<RigWeaponKey, AdsTiming>();

  /** A tuned override. ABSENT unless somebody moved a dial. Persisted. */
  private readonly adsOverrides = new Map<RigWeaponKey, AdsTiming>();

  /**
   * Record what the definition authors right now.
   *
   * Called every frame the weapon is equipped, so it mutates in place rather than
   * allocating, and it always takes the NEWER value — which is what makes an edit to
   * `weaponDefinitions.ts` visible immediately instead of one reload later.
   */
  seedAdsTiming(key: RigWeaponKey, enterSeconds: number, exitSeconds: number): void {
    const authored = this.adsAuthored.get(key);
    if (authored) {
      authored.enterSeconds = enterSeconds;
      authored.exitSeconds = exitSeconds;
    } else {
      this.adsAuthored.set(key, { enterSeconds, exitSeconds });
    }
  }

  /** What the source holds, or null before the weapon has ever been equipped. */
  adsAuthoredFor(key: RigWeaponKey): Readonly<AdsTiming> | null {
    return this.adsAuthored.get(key) ?? null;
  }

  /** What the frame should APPLY — null means the authored value stands untouched. */
  adsOverrideFor(key: RigWeaponKey): Readonly<AdsTiming> | null {
    return this.adsOverrides.get(key) ?? null;
  }

  /** What the panel should SHOW: the override when there is one, else the authored. */
  adsTimingFor(key: RigWeaponKey): Readonly<AdsTiming> | null {
    return this.adsOverrides.get(key) ?? this.adsAuthored.get(key) ?? null;
  }

  /** True while nothing shadows `weaponDefinitions.ts`. */
  adsIsDefault(key: RigWeaponKey): boolean {
    return !this.adsOverrides.has(key);
  }

  setAdsTiming(key: RigWeaponKey, field: keyof AdsTiming, value: number): void {
    let override = this.adsOverrides.get(key);
    if (!override) {
      const authored = this.adsAuthored.get(key);
      // Nothing to base an override on: the weapon has never been equipped, so the
      // authored value is not known and inventing one would be the shadowing bug again.
      if (!authored) return;
      override = { ...authored };
      this.adsOverrides.set(key, override);
    }
    override[field] = value;
    this.persistAdsTiming();
  }

  /** Drop the override so the value in `weaponDefinitions.ts` takes over again. */
  resetAdsTiming(key: RigWeaponKey): void {
    this.adsOverrides.delete(key);
    this.persistAdsTiming();
  }

  /** The tuned ADS timings as source, for `weaponDefinitions.ts`. Overrides only. */
  serializeAdsTiming(byRigKey: ReadonlyMap<RigWeaponKey, string>): string {
    const rows = [...this.adsOverrides]
      .filter(([key]) => byRigKey.has(key))
      .map(
        ([key, t]) =>
          `  // ${byRigKey.get(key)}\n  ads: { enterSeconds: ${+t.enterSeconds.toFixed(3)}, ` +
          `exitSeconds: ${+t.exitSeconds.toFixed(3)} },`
      );
    return rows.join("\n") || "  (nothing overrides the authored timings)";
  }

  private persistAdsTiming(): void {
    writeStored(ADS_KEY, JSON.stringify([...this.adsOverrides]));
  }

  private restoreAdsTiming(): void {
    const raw = readStored(ADS_KEY);
    if (!raw) return;
    try {
      for (const [key, timing] of JSON.parse(raw) as [RigWeaponKey, AdsTiming][]) {
        if (!RIG_WEAPON_KEYS.includes(key)) continue;
        if (Number.isFinite(timing?.enterSeconds) && Number.isFinite(timing?.exitSeconds)) {
          this.adsOverrides.set(key, {
            enterSeconds: timing.enterSeconds,
            exitSeconds: timing.exitSeconds,
          });
        }
      }
    } catch {
      // Same reasoning as the pose restore: the authored values are the correct fallback.
    }
  }

  /**
   * Live movement bob, PER WEAPON, created on first request.
   *
   * Sparse on purpose: a weapon with no entry uses the shared sourced defaults, so an
   * untuned weapon costs nothing and `serializeBob` prints only what somebody actually
   * changed. Ten full configs pasted into source would be 160 lines of mostly-identical
   * numbers, which is not a table anyone would keep correct.
   */
  private readonly bobByWeapon = new Map<RigWeaponKey, WeaponBobConfig>();

  bobFor(key: RigWeaponKey): WeaponBobConfig {
    let config = this.bobByWeapon.get(key);
    if (!config) {
      const seed = BOB_BY_WEAPON[key] ?? DEFAULT_WEAPON_BOB;
      config = { ...seed, walk: { ...seed.walk }, sprint: { ...seed.sprint } };
      this.bobByWeapon.set(key, config);
    }
    return config;
  }

  constructor() {
    restore(this.poses);
    this.restoreAdsTiming();
    this.restoreBob();
  }

  setBob(
    key: RigWeaponKey,
    gait: "walk" | "sprint",
    field: keyof WeaponBobGait,
    value: number
  ): void {
    this.bobFor(key)[gait][field] = value;
    this.persistBob();
  }

  resetBob(key: RigWeaponKey): void {
    const seed = BOB_BY_WEAPON[key] ?? DEFAULT_WEAPON_BOB;
    const config = this.bobFor(key);
    Object.assign(config.walk, seed.walk);
    Object.assign(config.sprint, seed.sprint);
    this.persistBob();
  }

  bobIsDefault(key: RigWeaponKey): boolean {
    const seed = BOB_BY_WEAPON[key] ?? DEFAULT_WEAPON_BOB;
    const config = this.bobFor(key);
    return (["walk", "sprint"] as const).every((gait) =>
      (Object.keys(seed[gait]) as (keyof WeaponBobGait)[]).every(
        (field) => config[gait][field] === seed[gait][field]
      )
    );
  }

  /** Only the weapons that differ from the shared defaults, as a BOB_BY_WEAPON block. */
  serializeBob(): string {
    const rows: string[] = [];
    for (const [key, config] of this.bobByWeapon) {
      if (this.bobIsDefault(key)) continue;
      const gait = (name: "walk" | "sprint") =>
        `      ${name}: { ` +
        (Object.keys(DEFAULT_WEAPON_BOB[name]) as (keyof WeaponBobGait)[])
          .map((field) => `${field}: ${+Number(config[name][field]).toFixed(4)}`)
          .join(", ") +
        ` },`;
      rows.push(`  ${key}: {\n    ...DEFAULT_WEAPON_BOB,\n${gait("walk")}\n${gait("sprint")}\n  },`);
    }
    return rows.join("\n") || "  (no weapon differs from the shared defaults yet)";
  }

  private persistBob(): void {
    const flat: Record<string, { walk: WeaponBobGait; sprint: WeaponBobGait }> = {};
    for (const [key, config] of this.bobByWeapon) {
      if (this.bobIsDefault(key)) continue;
      flat[key] = { walk: config.walk, sprint: config.sprint };
    }
    writeStored(BOB_KEY, JSON.stringify(flat));
  }

  private restoreBob(): void {
    const raw = readStored(BOB_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as Record<string, { walk: WeaponBobGait; sprint: WeaponBobGait }>;
      for (const [key, entry] of Object.entries(stored)) {
        if (!RIG_WEAPON_KEYS.includes(key as RigWeaponKey)) continue;
        const config = this.bobFor(key as RigWeaponKey);
        for (const name of ["walk", "sprint"] as const) {
          const from = entry?.[name];
          if (!from) continue;
          for (const field of Object.keys(DEFAULT_WEAPON_BOB[name]) as (keyof WeaponBobGait)[]) {
            const value = from[field];
            if (typeof value === "number" && Number.isFinite(value)) config[name][field] = value;
          }
        }
      }
    } catch {
      // Same reasoning as the pose restore: the sourced defaults are the correct fallback.
    }
  }

  get(key: RigWeaponKey): WeaponPose {
    return this.poses[key];
  }

  set(
    key: RigWeaponKey,
    mode: PoseMode,
    field: keyof PosePlacement,
    value: number
  ): void {
    this.poses[key][mode][field] = value;
    this.persist();
  }

  reset(key: RigWeaponKey): void {
    const fallback = DEFAULT_POSES[key];
    this.poses[key] = {
      hip: { ...fallback.hip },
      sprint: { ...fallback.sprint },
      ads: { ...fallback.ads },
    };
    this.persist();
  }

  isDefault(key: RigWeaponKey): boolean {
    const a = this.poses[key];
    const b = DEFAULT_POSES[key];
    return POSE_MODES.every((mode) =>
      [...POSE_AXES, ...POSE_ANGLES].every((field) => a[mode][field] === b[mode][field])
    );
  }

  /** The tuned table as source, ready to paste back over `DEFAULT_POSES`. */
  serialize(): string {
    // Emitted as `place(...)` calls rather than object literals, so the printed table is
    // the same shape as the one above and pastes straight over it. Trailing zero angles
    // are dropped because `place` defaults them, keeping an untilted weapon readable.
    const line = (v: PosePlacement) => {
      const parts = [v.x, v.y, v.z, v.pitch, v.yaw, v.roll].map((n) => String(+n.toFixed(3)));
      while (parts.length > 3 && parts[parts.length - 1] === "0") parts.pop();
      return `place(${parts.join(", ")})`;
    };
    const rows = Object.entries(this.poses).map(
      ([key, pose]) =>
        `  ${key}: { hip: ${line(pose.hip)}, sprint: ${line(pose.sprint)}, ads: ${line(pose.ads)} },`
    );
    return rows.join("\n");
  }

  private persist(): void {
    writeStored(POSE_KEY, JSON.stringify(this.poses));
  }
}

export const weaponPoses = new WeaponPoseStore();
