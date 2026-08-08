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

export type SpeciesId =
  | "scrub"
  | "bush"
  | "acacia"
  | "forest-tree-01"
  | "forest-tree-02"
  | "forest-tree-03"
  | "forest-tree-04";

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
  /**
   * Id of an authored mesh in `public/assets/vegetation/prototypes/prototypes.glb`,
   * or absent for procedural card species. A STRING, not a geometry: this table stays
   * Three-free and server-usable, and the renderer resolves the id at load. The
   * prototype is normalised to unit height, so `heightMetres` here is the one place
   * the tree's size is authored — trunk and radius figures below are the manifest's
   * unit measurements multiplied out, recomputed if the height changes.
   */
  readonly prototype?: string;
}

export const SPECIES: readonly Species[] = [
  // The four authored forest trees (CC-BY-4.0, attribution in the prototypes manifest).
  // First in the table because earlier rows out-compete later ones on shared sites, and
  // a rare tall tree losing its site to scrub would never appear at all. Trunk figures
  // are the extraction manifest's unit measurements × heightMetres; the stylised trunks
  // are FAT (0.7-1.75 m radius), so penetration thickness is capped as a tuning value
  // rather than following the 2×radius convention — 3.5 m of wood stops everything.
  {
    id: "forest-tree-01",
    displayName: "tall pine",
    heightMetres: 25.4,
    radiusMetres: 4.55,
    scaleRange: [0.8, 1.2],
    density: 0.006,
    minNormalY: 0.9,
    waterClearanceMetres: 2.0,
    lodScale: 14.7,
    trunk: {
      radiusMetres: 1.75,
      heightMetres: 23.1,
      surfaceId: "wood",
      penetrationThicknessMetres: 0.9,
    },
    foliageTint: [0.3, 0.42, 0.24],
    prototype: "forest-tree-01",
  },
  {
    id: "forest-tree-02",
    displayName: "broad pine",
    heightMetres: 18.5,
    radiusMetres: 5.5,
    scaleRange: [0.8, 1.2],
    density: 0.008,
    minNormalY: 0.88,
    waterClearanceMetres: 1.8,
    lodScale: 10.7,
    trunk: {
      radiusMetres: 1.37,
      heightMetres: 17.0,
      surfaceId: "wood",
      penetrationThicknessMetres: 0.8,
    },
    foliageTint: [0.32, 0.44, 0.25],
    prototype: "forest-tree-02",
  },
  {
    id: "forest-tree-03",
    displayName: "round crown",
    heightMetres: 11.9,
    radiusMetres: 4.3,
    scaleRange: [0.8, 1.25],
    density: 0.01,
    minNormalY: 0.86,
    waterClearanceMetres: 1.5,
    lodScale: 6.9,
    trunk: {
      radiusMetres: 1.44,
      heightMetres: 9.8,
      surfaceId: "wood",
      penetrationThicknessMetres: 0.8,
    },
    foliageTint: [0.34, 0.45, 0.26],
    prototype: "forest-tree-03",
  },
  {
    id: "forest-tree-04",
    displayName: "slim pine",
    heightMetres: 10.3,
    radiusMetres: 3.0,
    scaleRange: [0.8, 1.25],
    density: 0.01,
    minNormalY: 0.86,
    waterClearanceMetres: 1.5,
    lodScale: 6.0,
    trunk: {
      radiusMetres: 0.72,
      heightMetres: 9.5,
      surfaceId: "wood",
      penetrationThicknessMetres: 0.7,
    },
    foliageTint: [0.33, 0.44, 0.25],
    prototype: "forest-tree-04",
  },
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
