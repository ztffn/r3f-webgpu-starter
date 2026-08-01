import type { AmmunitionDefinition } from "../weapons/AmmunitionDefinition";
import { kineticEnergyJoules } from "../weapons/AmmunitionDefinition.ts";
import type { SurfaceProfile } from "./SurfaceProfile";

export type PenetrationOutcome = "penetrated" | "stopped";

export interface PenetrationInput {
  readonly ammunition: AmmunitionDefinition;
  readonly surface: SurfaceProfile;
  readonly speedMetresPerSecond: number;
  readonly thicknessMetres: number;
  /** Absolute unit-direction dot unit-normal. Zero is grazing; one is square-on. */
  readonly incidenceCosine: number;
}

export interface PenetrationResult {
  readonly outcome: PenetrationOutcome;
  readonly effectiveThicknessMetres: number;
  readonly energyBeforeJoules: number;
  readonly energyAfterJoules: number;
  readonly speedAfterMetresPerSecond: number;
}

/** Pure deterministic terminal model shared by live projectiles and tests. */
export function resolvePenetration(input: PenetrationInput): PenetrationResult {
  const energyBefore = kineticEnergyJoules(input.ammunition, input.speedMetresPerSecond);
  if (!Number.isFinite(input.thicknessMetres) || input.thicknessMetres < 0) {
    return {
      outcome: "stopped",
      effectiveThicknessMetres: 0,
      energyBeforeJoules: energyBefore,
      energyAfterJoules: 0,
      speedAfterMetresPerSecond: 0,
    };
  }
  const thickness = input.thicknessMetres;
  const rawCosine = Number.isFinite(input.incidenceCosine)
    ? Math.abs(input.incidenceCosine)
    : 0;
  const cosine = Math.min(1, Math.max(0, rawCosine));
  const pathMultiplier = Math.min(
    input.surface.maxIncidencePathMultiplier,
    1 / Math.max(cosine, 1 / input.surface.maxIncidencePathMultiplier)
  );
  const effectiveThickness = thickness * pathMultiplier;
  const energyCost =
    (input.surface.resistanceJoulesPerMetre * effectiveThickness) /
    input.ammunition.penetrationMultiplier;
  const retained = Math.max(0, energyBefore - energyCost);
  const penetrated = retained >= input.surface.minimumExitEnergyJoules;
  return {
    outcome: penetrated ? "penetrated" : "stopped",
    effectiveThicknessMetres: effectiveThickness,
    energyBeforeJoules: energyBefore,
    energyAfterJoules: penetrated ? retained : 0,
    speedAfterMetresPerSecond: penetrated
      ? Math.sqrt((2 * retained) / input.ammunition.projectileMassKilograms)
      : 0,
  };
}
