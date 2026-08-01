import type { WeaponDefinition } from "./WeaponDefinition";

export const SNIPER_DEFINITION: WeaponDefinition = {
  id: "prototype-sniper",
  displayName: "Prototype Sniper",
  shot: {
    type: "ballistic",
    damage: 100,
    range: 2_000,
    roundsPerMinute: 48,
    // Baseline: 175 gr .308 match profile, 2,600 ft/s and G1 BC 0.505.
    muzzleVelocityMetresPerSecond: 792.48,
    ballisticCoefficientG1: 0.505,
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
