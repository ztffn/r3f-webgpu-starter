import type { WeaponDefinition } from "./WeaponDefinition.ts";
import { AMMUNITION_DEFINITIONS, DEFAULT_AMMUNITION } from "./AmmunitionDefinition.ts";

const AMMO_556 = AMMUNITION_DEFINITIONS["556"];
const AMMO_9MM = AMMUNITION_DEFINITIONS["9mm"];

export const SNIPER_DEFINITION: WeaponDefinition = {
  id: "prototype-sniper",
  displayName: "Sniper",
  shot: {
    type: "ballistic",
    damage: DEFAULT_AMMUNITION.baseDamage,
    range: 2_000,
    // Covers the current 1,300 m profiles while bounding missed rounds.
    maxFlightSeconds: 3.5,
    roundsPerMinute: 48,
    ammunition: DEFAULT_AMMUNITION,
  },
  ammo: {
    magazineSize: 5,
    initialReserve: 20,
  },
  reload: {
    // Authored segment 4 spans 10.833333–15.0 s (4.167 s). Keep gameplay
    // locked slightly longer so a newly accepted shot cannot cut the clip.
    durationSeconds: 4.2,
  },
  fireModes: {
    supported: ["semi"],
    default: "semi",
  },
  ads: {
    enterSeconds: 0.22,
    exitSeconds: 0.16,
  },
  accuracy: {
    mechanicalDispersionRadians: 0.00025,
    hipDispersionRadians: 0.006,
    movementDispersionRadians: 0.008,
    airborneDispersionRadians: 0.012,
    bloomPerShotRadians: 0.0004,
    maxBloomRadians: 0.002,
    bloomRecoveryPerSecond: 7,
  },
  recoil: {
    pitchRadians: 0.018,
    yawRadians: 0.004,
    recoveryPerSecond: 7,
    maxPitchRadians: 0.045,
    maxYawRadians: 0.015,
  },
};

export const M4_DEFINITION: WeaponDefinition = {
  id: "m4",
  displayName: "M4",
  shot: {
    type: "ballistic",
    damage: AMMO_556.baseDamage,
    range: 1_200,
    maxFlightSeconds: 3.5,
    roundsPerMinute: 600,
    ammunition: AMMO_556,
  },
  ammo: { magazineSize: 30, initialReserve: 120 },
  reload: { durationSeconds: 4.2 },
  fireModes: {
    supported: ["semi", "burst"],
    default: "semi",
    burstSize: 3,
  },
  ads: { enterSeconds: 0.18, exitSeconds: 0.14 },
  accuracy: {
    mechanicalDispersionRadians: 0.00045,
    hipDispersionRadians: 0.008,
    movementDispersionRadians: 0.01,
    airborneDispersionRadians: 0.014,
    bloomPerShotRadians: 0.0011,
    maxBloomRadians: 0.007,
    bloomRecoveryPerSecond: 5.5,
  },
  recoil: {
    pitchRadians: 0.009,
    yawRadians: 0.003,
    recoveryPerSecond: 5.5,
    maxPitchRadians: 0.045,
    maxYawRadians: 0.015,
  },
};

export const GLOCK_DEFINITION: WeaponDefinition = {
  id: "glock-9mm",
  displayName: "Glock",
  shot: {
    type: "ballistic",
    damage: AMMO_9MM.baseDamage,
    range: 250,
    maxFlightSeconds: 2,
    roundsPerMinute: 400,
    ammunition: AMMO_9MM,
  },
  ammo: { magazineSize: 17, initialReserve: 68 },
  reload: { durationSeconds: 4.2 },
  fireModes: { supported: ["semi"], default: "semi" },
  ads: { enterSeconds: 0.14, exitSeconds: 0.12 },
  accuracy: {
    mechanicalDispersionRadians: 0.0015,
    hipDispersionRadians: 0.01,
    movementDispersionRadians: 0.012,
    airborneDispersionRadians: 0.016,
    bloomPerShotRadians: 0.001,
    maxBloomRadians: 0.005,
    bloomRecoveryPerSecond: 7,
  },
  recoil: {
    pitchRadians: 0.012,
    yawRadians: 0.004,
    recoveryPerSecond: 7,
    maxPitchRadians: 0.036,
    maxYawRadians: 0.015,
  },
};

export const SAW_DEFINITION: WeaponDefinition = {
  id: "saw-test",
  displayName: "SAW",
  shot: {
    type: "ballistic",
    damage: AMMO_556.baseDamage,
    range: 1_200,
    maxFlightSeconds: 3.5,
    roundsPerMinute: 900,
    ammunition: AMMO_556,
  },
  ammo: { magazineSize: 100, initialReserve: 200 },
  reload: { durationSeconds: 4.2 },
  fireModes: { supported: ["semi", "auto"], default: "auto" },
  ads: { enterSeconds: 0.24, exitSeconds: 0.18 },
  accuracy: {
    mechanicalDispersionRadians: 0.0007,
    hipDispersionRadians: 0.01,
    movementDispersionRadians: 0.014,
    airborneDispersionRadians: 0.018,
    bloomPerShotRadians: 0.0014,
    maxBloomRadians: 0.01,
    bloomRecoveryPerSecond: 4.5,
  },
  recoil: {
    pitchRadians: 0.011,
    yawRadians: 0.004,
    recoveryPerSecond: 4.5,
    maxPitchRadians: 0.065,
    maxYawRadians: 0.022,
  },
};

/**
 * Canonical order IS the wire encoding: a weapon's index here is the u8 the
 * client sends in a SelectWeapon message and the identity the server resolves
 * damage with. Append only — reordering silently re-arms every player.
 */
export const WEAPON_DEFINITIONS = [
  SNIPER_DEFINITION,
  M4_DEFINITION,
  GLOCK_DEFINITION,
  SAW_DEFINITION,
] as const;

/**
 * Seconds a weapon switch takes. ONE number for both sides of the wire: the
 * client's LoadoutSystem animates it and the server's loadout record gates
 * fire acceptance on it — copied literals here would drift into the server
 * refusing legal shots after every switch.
 */
export const WEAPON_SWITCH_SECONDS = 0.35;

/** Wire index for a weapon id, or null for a weapon the wire cannot name. */
export function weaponWireIndex(weaponId: string): number | null {
  const index = WEAPON_DEFINITIONS.findIndex((definition) => definition.id === weaponId);
  return index >= 0 ? index : null;
}

/** Definition for a wire index, or null for an index out of range (hostile input). */
export function weaponByWireIndex(index: number): WeaponDefinition | null {
  return Number.isInteger(index) ? (WEAPON_DEFINITIONS[index] ?? null) : null;
}
