import type { WeaponDefinition } from "./WeaponDefinition";
import { DEFAULT_AMMUNITION } from "./AmmunitionDefinition.ts";

export const SNIPER_DEFINITION: WeaponDefinition = {
  id: "prototype-sniper",
  displayName: "Prototype Sniper",
  shot: {
    type: "ballistic",
    damage: DEFAULT_AMMUNITION.baseDamage,
    range: 2_000,
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
    reloadSegment: 4,
  },
};

export const WEAPON_DEFINITIONS = [SNIPER_DEFINITION] as const;
