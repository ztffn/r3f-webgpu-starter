export type SurfaceId =
  | "cloth"
  | "wood"
  | "sheet-metal"
  | "armored-metal"
  | "stone"
  | "dirt"
  | "flesh"
  | "water"
  | "glass";

export type ImpactSoundKind =
  | "soft"
  | "wood"
  | "metal"
  | "stone"
  | "flesh"
  | "water"
  | "glass";

export interface SurfaceEffectProfile {
  readonly color: number;
  readonly particleCount: number;
  readonly particleSpeed: number;
  readonly sound: ImpactSoundKind;
  readonly audibleDistanceMetres: number;
}

export interface SurfaceProfile {
  readonly id: SurfaceId;
  readonly displayName: string;
  /** Authored gameplay resistance; not a claim of laboratory material behavior. */
  readonly resistanceJoulesPerMetre: number;
  readonly minimumExitEnergyJoules: number;
  readonly maxIncidencePathMultiplier: number;
  readonly effect: SurfaceEffectProfile;
}

const effect = (
  color: number,
  particleCount: number,
  particleSpeed: number,
  sound: ImpactSoundKind,
  audibleDistanceMetres: number
): SurfaceEffectProfile => ({ color, particleCount, particleSpeed, sound, audibleDistanceMetres });

export const SURFACE_PROFILES: Readonly<Record<SurfaceId, SurfaceProfile>> = {
  cloth: {
    id: "cloth",
    displayName: "cloth",
    resistanceJoulesPerMetre: 350,
    minimumExitEnergyJoules: 25,
    maxIncidencePathMultiplier: 4,
    effect: effect(0xb3aa83, 3, 0.8, "soft", 55),
  },
  wood: {
    id: "wood",
    displayName: "wood",
    resistanceJoulesPerMetre: 7_000,
    minimumExitEnergyJoules: 45,
    maxIncidencePathMultiplier: 4,
    effect: effect(0xb9864e, 8, 3.2, "wood", 110),
  },
  "sheet-metal": {
    id: "sheet-metal",
    displayName: "sheet metal",
    resistanceJoulesPerMetre: 180_000,
    minimumExitEnergyJoules: 70,
    maxIncidencePathMultiplier: 5,
    effect: effect(0xffc94a, 10, 5.5, "metal", 180),
  },
  "armored-metal": {
    id: "armored-metal",
    displayName: "armored metal",
    resistanceJoulesPerMetre: 1_250_000,
    minimumExitEnergyJoules: 150,
    maxIncidencePathMultiplier: 5,
    effect: effect(0xffd875, 12, 6.5, "metal", 220),
  },
  stone: {
    id: "stone",
    displayName: "stone",
    resistanceJoulesPerMetre: 240_000,
    minimumExitEnergyJoules: 80,
    maxIncidencePathMultiplier: 3,
    effect: effect(0xc7c3b5, 10, 3.8, "stone", 150),
  },
  dirt: {
    id: "dirt",
    displayName: "dirt",
    resistanceJoulesPerMetre: 18_000,
    minimumExitEnergyJoules: 35,
    maxIncidencePathMultiplier: 2.5,
    effect: effect(0x8b6946, 12, 2.4, "soft", 90),
  },
  flesh: {
    id: "flesh",
    displayName: "flesh",
    resistanceJoulesPerMetre: 3_500,
    minimumExitEnergyJoules: 35,
    maxIncidencePathMultiplier: 3,
    effect: effect(0x9f1f25, 7, 2.1, "flesh", 100),
  },
  water: {
    id: "water",
    displayName: "water",
    resistanceJoulesPerMetre: 24_000,
    minimumExitEnergyJoules: 30,
    maxIncidencePathMultiplier: 3,
    effect: effect(0x7dcfff, 12, 3.2, "water", 120),
  },
  glass: {
    id: "glass",
    displayName: "glass",
    resistanceJoulesPerMetre: 16_000,
    minimumExitEnergyJoules: 30,
    maxIncidencePathMultiplier: 4,
    effect: effect(0xc8f1ff, 12, 4.2, "glass", 140),
  },
};

export const DEFAULT_SURFACE_BY_KIND = {
  terrain: "dirt",
  target: "flesh",
  world: "stone",
} as const;

export const DEFAULT_THICKNESS_BY_KIND = {
  terrain: 100,
  target: 0.24,
  world: 1,
} as const;
