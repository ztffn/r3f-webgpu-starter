import type { WeaponDefinition } from "./WeaponDefinition";

export const SNIPER_DEFINITION: WeaponDefinition = {
  id: "prototype-sniper",
  displayName: "Prototype Sniper",
  shot: {
    type: "hitscan",
    damage: 100,
    range: 2_000,
    roundsPerMinute: 48,
  },
  ammo: {
    magazineSize: 5,
    initialReserve: 20,
  },
  reload: {
    durationSeconds: 2.4,
  },
  ads: {
    enterSeconds: 0.22,
    exitSeconds: 0.16,
  },
  recoil: {
    pitchRadians: 0.018,
    yawRadians: 0.004,
  },
  // The source GLB is still an eight-action demonstration reel. Keep the
  // mapping data-driven even though the exact authored labels are unavailable.
  animations: {
    fireSegment: 5,
    reloadSegment: 2,
  },
};

export const WEAPON_DEFINITIONS = [SNIPER_DEFINITION] as const;
