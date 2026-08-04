export type AmmunitionId = "9mm" | "556" | "308" | "50bmg";

/** Representative external-ballistic data plus deliberately game-tuned terminal response. */
export interface AmmunitionDefinition {
  readonly id: AmmunitionId;
  readonly displayName: string;
  readonly projectileMassKilograms: number;
  readonly muzzleVelocityMetresPerSecond: number;
  readonly ballisticCoefficientG1: number;
  readonly baseDamage: number;
  /** Converts kinetic energy into an authored material-penetration budget. */
  readonly penetrationMultiplier: number;
}

export const AMMUNITION_DEFINITIONS: Readonly<Record<AmmunitionId, AmmunitionDefinition>> = {
  "9mm": {
    id: "9mm",
    displayName: "9x19 mm 124 gr",
    projectileMassKilograms: 0.00804,
    muzzleVelocityMetresPerSecond: 350.52,
    ballisticCoefficientG1: 0.159,
    baseDamage: 42,
    penetrationMultiplier: 0.72,
  },
  "556": {
    id: "556",
    displayName: "5.56x45 mm 62 gr",
    projectileMassKilograms: 0.00402,
    muzzleVelocityMetresPerSecond: 920.5,
    ballisticCoefficientG1: 0.349,
    baseDamage: 68,
    penetrationMultiplier: 1.15,
  },
  "308": {
    id: "308",
    displayName: ".308 Winchester 175 gr",
    projectileMassKilograms: 0.01134,
    muzzleVelocityMetresPerSecond: 792.48,
    ballisticCoefficientG1: 0.505,
    baseDamage: 100,
    penetrationMultiplier: 1.08,
  },
  "50bmg": {
    id: "50bmg",
    displayName: ".50 BMG 660 gr",
    projectileMassKilograms: 0.0428,
    muzzleVelocityMetresPerSecond: 853,
    ballisticCoefficientG1: 0.62,
    baseDamage: 250,
    penetrationMultiplier: 2.35,
  },
};

export const DEFAULT_AMMUNITION = AMMUNITION_DEFINITIONS["308"];

export function ammunitionFromSearch(search: string): AmmunitionDefinition {
  const requested = new URLSearchParams(search).get("ammo");
  // Own-property only. A plain object literal inherits from Object.prototype,
  // so `?ammo=constructor` would otherwise return a truthy function and pass
  // straight through the fallback into weapon construction.
  if (requested !== null && Object.hasOwn(AMMUNITION_DEFINITIONS, requested)) {
    return AMMUNITION_DEFINITIONS[requested as AmmunitionId];
  }
  return DEFAULT_AMMUNITION;
}

export function kineticEnergyJoules(
  ammunition: Pick<AmmunitionDefinition, "projectileMassKilograms">,
  speedMetresPerSecond: number
): number {
  return 0.5 * ammunition.projectileMassKilograms * speedMetresPerSecond ** 2;
}
