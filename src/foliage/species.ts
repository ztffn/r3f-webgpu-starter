// Vegetation species table — authored gameplay data, no renderer types.
//
// A species is a gameplay object first and a mesh second, which is the ordering the
// research memo argues for and the ordering this project already uses for terrain
// (docs/08 §3: the CPU heightfield knows nothing about Three.js). The renderer builds
// geometry FROM this table; the ballistics query and any future concealment query read
// the same rows. Nothing here may be re-derived somewhere else — that is the failure
// this codebase has already paid for twice (docs/08 §11, "three surfaces where there
// should be one").

import type { SurfaceId } from "../combat/SurfaceProfile.ts";

export type SpeciesId = "scrub" | "bush" | "acacia";

/**
 * The ballistic proxy: what a bullet hits. Deliberately NOT derived from the visual
 * mesh and deliberately NOT affected by visual LOD (research memo §7: "collision and
 * ballistic proxies must not change with visual LOD"). A trunk is a vertical cylinder;
 * foliage without one stops nothing.
 */
export interface TrunkProxy {
  readonly radiusMetres: number;
  readonly heightMetres: number;
  readonly surfaceId: SurfaceId;
  /**
   * Path length a bullet is charged for crossing the trunk, metres. Independent of the
   * geometric diameter so it can be tuned as gameplay resistance rather than as physics
   * — the same convention `WorldObjectDefinition.collider` already uses.
   */
  readonly penetrationThicknessMetres: number;
}

export interface Species {
  readonly id: SpeciesId;
  readonly displayName: string;
  /** Height at scale 1, metres, ground to top of foliage. */
  readonly heightMetres: number;
  /** Foliage radius at scale 1, metres. Bounds the instance and the cell's sphere. */
  readonly radiusMetres: number;
  /** Uniform scale range applied per instance. */
  readonly scaleRange: readonly [number, number];
  /**
   * Probability a candidate site becomes this species, before habitat filtering.
   * Species are tested in table order and the first acceptance wins, so earlier rows
   * out-compete later ones on sites both would take.
   */
  readonly density: number;
  /** Steepest ground this species grows on, as |normal.y| — 1 is flat. */
  readonly minNormalY: number;
  /** Metres of clearance above water level required. */
  readonly waterClearanceMetres: number;
  /**
   * Multiplier on FOLIAGE_LOD_DISTANCES. This is the projected-screen-size correction
   * the research memo asks for, factored into a per-species constant: a 6 m acacia
   * subtends ten times the angle of a 0.6 m scrub at the same range, so it must hold
   * its detail ten times further out to switch at the same apparent size.
   */
  readonly lodScale: number;
  /** Null for pure foliage: leaves conceal, they do not stop bullets. */
  readonly trunk: TrunkProxy | null;
  /** Tint applied to the shared leaf atlas, so one texture serves every species. */
  readonly foliageTint: readonly [number, number, number];
}

export const SPECIES: readonly Species[] = [
  {
    id: "acacia",
    displayName: "acacia",
    heightMetres: 6.2,
    radiusMetres: 3.4,
    scaleRange: [0.75, 1.35],
    density: 0.05,
    minNormalY: 0.86,
    waterClearanceMetres: 1.5,
    lodScale: 3.6,
    trunk: {
      radiusMetres: 0.19,
      heightMetres: 3.1,
      surfaceId: "wood",
      penetrationThicknessMetres: 0.38,
    },
    foliageTint: [0.42, 0.5, 0.28],
  },
  {
    id: "bush",
    displayName: "bush",
    heightMetres: 1.55,
    radiusMetres: 1.05,
    scaleRange: [0.7, 1.4],
    density: 0.22,
    minNormalY: 0.78,
    waterClearanceMetres: 0.6,
    lodScale: 1.15,
    trunk: null,
    foliageTint: [0.4, 0.47, 0.25],
  },
  {
    id: "scrub",
    displayName: "scrub",
    heightMetres: 0.62,
    radiusMetres: 0.58,
    scaleRange: [0.65, 1.5],
    density: 0.42,
    minNormalY: 0.6,
    waterClearanceMetres: 0.25,
    lodScale: 0.55,
    trunk: null,
    foliageTint: [0.46, 0.46, 0.24],
  },
];

export const SPECIES_BY_ID: Readonly<Record<SpeciesId, Species>> = Object.freeze(
  SPECIES.reduce(
    (acc, species) => {
      acc[species.id] = species;
      return acc;
    },
    {} as Record<SpeciesId, Species>
  )
);

/** Table index, which is what instance records store — one byte instead of a string. */
export function speciesIndex(id: SpeciesId): number {
  const index = SPECIES.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`Unknown species: ${id}`);
  return index;
}
