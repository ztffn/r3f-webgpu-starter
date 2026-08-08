// False-colour debug views for the vegetation layer — LOD, tier, species and cell.
//
// The grass march's pattern (GrassMaterial's `uDebugMode`), adapted to a layer whose
// colour cannot be switched by a uniform: LOD is decided PER BUCKET while one material is
// shared by every bucket of a species, so no uniform can carry it. The near tier's frame
// loop instead swaps in a material keyed on (species, palette slot), which also sidesteps
// that tier being lit — a flat colour written to a lit material's colorNode comes back
// multiplied by PBR and then graded and fogged, unreadable as false colour. The far ring
// is unlit and one material per species already, so it switches on the uniform directly.

import * as THREE from "three/webgpu";
import { attribute, float, mix, positionWorld, texture, uv, vec3 } from "three/tsl";
import { FOLIAGE_ALPHA_CUTOFF } from "./foliageConfig.ts";
import type { FoliageUniforms } from "./FoliageMaterial.ts";
import { SPECIES } from "./species.ts";
import type { FoliageOverdrawSample } from "./FoliageOverdrawProbe.tsx";

/**
 * The view modes, in the order the panel lists them. The uniform stores the INDEX.
 *
 * `collision` is declared but inert: trunk proxies are queried analytically
 * (VegetationWorldQuery) and stop bullets on the client only, so there is nothing
 * authoritative to draw yet. It is listed so the panel can show it as unavailable rather
 * than omit it — an absent control reads as "this does not exist", which is a different
 * and wrong claim (the project has been bitten by unknown-rendered-as-a-value before).
 */
export const FOLIAGE_DEBUG_MODES = [
  "Normal",
  "LOD",
  "Tier",
  "Species",
  "Cells",
  "Overdraw",
  "Collision",
] as const;

/** What each view answers. The labels are the codebase's own terms; this is where
 * they get explained, so the row stays short and the vocabulary stays consistent. */
export const FOLIAGE_DEBUG_HINTS: readonly string[] = [
  "the real render.",
  "geometric detail per cell: green nearest, then yellow and orange, red is the in-window impostor. A whole cell switches at once, so the bands are cell-shaped.",
  "which renderer drew it — cyan is the near window (real geometry), magenta is the far ring (baked impostor photos). Shows where the handoff lands, and any gap or overlap.",
  "one colour per plant type, for reading the placement mix.",
  "the 32 m bucket each plant belongs to. That bucket is the unit of frustum culling AND the unit of LOD choice, which is why plants pop in groups.",
  "foliage layers per pixel — the fill cost that dominates dense vegetation. Each layer adds one eighth, so white on screen is 8 or more. The measured figures below are exact.",
  "reserved — see below.",
];

export type FoliageDebugMode = (typeof FOLIAGE_DEBUG_MODES)[number];

export const FOLIAGE_DEBUG_OFF = 0;
export const FOLIAGE_DEBUG_LOD = 1;
export const FOLIAGE_DEBUG_TIER = 2;
export const FOLIAGE_DEBUG_SPECIES = 3;
export const FOLIAGE_DEBUG_CELL = 4;
export const FOLIAGE_DEBUG_OVERDRAW = 5;
export const FOLIAGE_DEBUG_COLLISION = 6;

/**
 * Brightness one foliage layer contributes in the overdraw view.
 *
 * An eighth, so the on-screen accumulation saturates at 8 layers and the ramp stays
 * readable. The MEASUREMENT does not use the screen: it renders the same materials to a
 * half-float target, where the sum is unclamped and layers = value / this. Nothing about
 * the number depends on what the monitor could display.
 */
export const FOLIAGE_OVERDRAW_STEP = 1 / 8;

/** Modes with nothing wired behind them yet; the panel disables these. */
export const FOLIAGE_DEBUG_UNAVAILABLE: readonly number[] = [FOLIAGE_DEBUG_COLLISION];

/**
 * Palette slots, chosen to stay distinguishable against terrain and sky rather than to
 * look good: LOD reads as a heat ramp (green near, red at the in-window impostor) and the
 * remaining slots are spread around the hue circle so adjacent species do not blend.
 */
const PALETTE: readonly [number, number, number][] = [
  [0.15, 0.85, 0.25], // 0 — LOD 0 / species 0
  [0.95, 0.85, 0.1], // 1 — LOD 1 / species 1
  [1.0, 0.5, 0.05], // 2 — LOD 2 / species 2
  [1.0, 0.12, 0.12], // 3 — LOD 3 (in-window impostor) / species 3
  [0.2, 0.6, 1.0], // 4 — species 4
  [0.85, 0.25, 1.0], // 5 — species 5
  [0.1, 0.9, 0.85], // 6 — species 6
  [1.0, 1.0, 1.0], // 7 — spare
];

/** The in-window impostor LOD's slot — the last step of the LOD ramp. */
export const FOLIAGE_LOD_IMPOSTOR_SLOT = 3;

/** Near window and far ring, for the tier view. */
export const FOLIAGE_TIER_NEAR_SLOT = 6;
export const FOLIAGE_TIER_FAR_SLOT = 5;

export function foliageDebugColor(slot: number): readonly [number, number, number] {
  return PALETTE[slot % PALETTE.length];
}

/**
 * Live debug handles the panel mutates and the frame loops read.
 *
 * A plain mutable object, not React state and not all uniforms: species visibility and
 * the LOD-distance scale are CPU decisions (a hidden species should cost no draw call at
 * all, which is the entire point of the toggle — a shader that discards still pays for
 * the draw). `uniforms` rides along because the far ring needs `debugMode` on the GPU.
 */
export interface FoliageDebugControls {
  uniforms: FoliageUniforms;
  /**
   * Per-species render toggle, for attributing GPU cost to one plant.
   *
   * Applies to BOTH tiers, so switching a species off removes its near buckets and its
   * impostor ring together — a measurement that hid only one of them would move cost
   * between tiers instead of removing it.
   */
  speciesVisible: boolean[];
  /**
   * Multiplier on every LOD switch distance. 1 is shipped behaviour.
   *
   * One dial rather than three thresholds: the tiers are already tuned relative to each
   * other and per-species by `lodScale`, so the useful question is "what does moving the
   * whole ramp in or out cost", not "where exactly is tier 2".
   */
  lodDistanceScale: number;
  /**
   * Which tiers draw. Isolation, not a feature toggle.
   *
   * Three doesn't expose per-pass GPU timestamps, so the only honest way to attribute
   * frame cost to a tier is to remove it and measure the difference. These make that a
   * click instead of a rebuild.
   */
  nearVisible: boolean;
  farVisible: boolean;
  /**
   * Latest measured depth complexity, or null when nothing has been measured.
   *
   * NULL IS LOAD-BEARING: it means "not measured", which is a different claim from zero
   * overdraw, and the panel must render it as absent rather than as a number.
   */
  overdraw: FoliageOverdrawSample | null;
}

export function createFoliageDebugControls(uniforms: FoliageUniforms): FoliageDebugControls {
  return {
    uniforms,
    speciesVisible: SPECIES.map(() => true),
    lodDistanceScale: 1,
    nearVisible: true,
    farVisible: true,
    overdraw: null,
  };
}

export interface FoliageDebugMaterials {
  /**
   * The material for one bucket. `slot` is a palette index, or -1 for the cell hash.
   *
   * Keyed on (species, slot) and built on demand: the colour has to vary per BUCKET —
   * that is the whole point of the LOD view — while the alpha cutout has to come from
   * that species' own texture, and no single material can do both.
   */
  materialFor(speciesIndex: number, slot: number): THREE.MeshBasicNodeMaterial;
  /**
   * Additive material whose accumulated red channel counts foliage layers.
   *
   * Keeps the alpha test, so a fragment only counts if it would actually have been
   * shaded — the leaf texture's holes are not fill cost. Writes no depth, so every layer
   * accumulates instead of the nearest one winning; that makes the result DEPTH
   * COMPLEXITY, the upper bound on shading work, which is the quantity that grows with
   * density and the one worth tuning against.
   */
  overdrawMaterialFor(speciesIndex: number): THREE.MeshBasicNodeMaterial;
  dispose(): void;
}

export interface FoliageDebugOptions {
  cellSize: number;
  /** The shared card texture, used by every procedural species. */
  cardMap: THREE.Texture;
  /** A prototype species' own leaf texture, or null when the species uses `cardMap`. */
  leafMapFor: (speciesIndex: number) => THREE.Texture | null;
}

// The convention atmosphere.ts uses: TSL's overloaded node types collapse under
// inference, so graph-shaped values go untyped and tsc checks the structure instead.
type NodeArg = any;

/** One channel of a stable per-cell hash, in [0,1). */
function cellHashChannel(cell: NodeArg, kx: number, ky: number): NodeArg {
  return cell.x.mul(kx).add(cell.y.mul(ky)).sin().mul(43758.5453).fract().abs();
}

/**
 * Colour for the cell a world position stands in, as a TSL node.
 *
 * Derived in the shader rather than from CPU state so one material serves every cell and
 * the view survives buckets being re-pointed without any buffer rewrite. Shared by both
 * tiers so a cell reads the SAME colour in the near window and in the far ring — which is
 * the whole point of the view: the handoff should be invisible in cell space.
 *
 * Floored at 0.3 so no cell can hash to near-black and read as unlit rather than as a value.
 */
export function foliageDebugCellColor(worldXZ: NodeArg, cellSize: number): NodeArg {
  const cell = worldXZ.div(float(cellSize)).floor();
  return vec3(
    cellHashChannel(cell, 127.1, 311.7).mul(0.7).add(0.3),
    cellHashChannel(cell, 269.5, 183.3).mul(0.7).add(0.3),
    cellHashChannel(cell, 419.2, 371.9).mul(0.7).add(0.3)
  );
}

/**
 * The debug palette as materials, built on demand and cached.
 *
 * UNLIT and with no positionNode, and both are deliberate. Unlit because these must come
 * out of the frame the exact colour they went in — no lighting, no grade, no fog — which
 * is the same bypass the grass debug views use. No positionNode because NodeMaterial has
 * already applied the instance matrix by the time one would run, and `fill` writes the
 * full transform into it: the only things the real material's positionNode adds are the
 * billboard and the wind, and neither carries information a false-colour view is reading.
 *
 * THE ALPHA CUTOUT IS KEPT, unlike the grass debug views, and the difference is not an
 * oversight. Grass forces opacity because a miss there is empty air and would show
 * terrain through it. A foliage card is mostly hole BY CONSTRUCTION — the leaf texture is
 * the plant's shape — so forcing it opaque turns every card into a solid quad, and a
 * camera standing in a stand sees one flat wall of the palette colour instead of the LOD
 * banding it was opened to read. Measured in the browser: opaque filled the frame.
 *
 * Lazy because a mode only ever touches a few (species, slot) pairs, and each material is
 * a pipeline the backend has to compile.
 */
export function createFoliageDebugMaterials(
  options: FoliageDebugOptions
): FoliageDebugMaterials {
  const cache = new Map<string, THREE.MeshBasicNodeMaterial>();

  return {
    materialFor(speciesIndex, slot) {
      const key = `${speciesIndex}:${slot}`;
      const cached = cache.get(key);
      if (cached) return cached;

      const material = new THREE.MeshBasicNodeMaterial();
      material.name = `foliage-debug-${speciesIndex}-${slot}`;
      material.side = THREE.DoubleSide;
      material.fog = false;
      material.alphaTest = FOLIAGE_ALPHA_CUTOFF;

      // Same shape as the real materials': bark is solid, leaves cut against the map.
      const map = options.leafMapFor(speciesIndex) ?? options.cardMap;
      const leafFlag: NodeArg = attribute<"float">("leaf", "float");
      material.opacityNode = mix(float(1), texture(map, uv()).a, leafFlag);

      material.colorNode =
        slot < 0
          ? foliageDebugCellColor(positionWorld.xz, options.cellSize)
          : vec3(...foliageDebugColor(slot));

      cache.set(key, material);
      return material;
    },
    overdrawMaterialFor(speciesIndex) {
      const key = `overdraw:${speciesIndex}`;
      const cached = cache.get(key);
      if (cached) return cached;

      const material = new THREE.MeshBasicNodeMaterial();
      material.name = `foliage-overdraw-${speciesIndex}`;
      material.side = THREE.DoubleSide;
      material.fog = false;
      material.alphaTest = FOLIAGE_ALPHA_CUTOFF;
      material.blending = THREE.AdditiveBlending;
      material.transparent = true;
      material.depthWrite = false;

      const map = options.leafMapFor(speciesIndex) ?? options.cardMap;
      const leafFlag: NodeArg = attribute<"float">("leaf", "float");
      material.opacityNode = mix(float(1), texture(map, uv()).a, leafFlag);
      // RED carries the count exactly — one step per layer — so the readback divides by
      // the step and is done. Green and blue only make the on-screen ramp legible.
      const step = FOLIAGE_OVERDRAW_STEP;
      material.colorNode = vec3(step, step * 0.55, step * 0.15);

      cache.set(key, material);
      return material;
    },
    dispose() {
      for (const material of cache.values()) material.dispose();
      cache.clear();
    },
  };
}

/**
 * Which palette slot a near-tier bucket takes, or -1 for "use the cell-hash material".
 *
 * Returns null when the mode draws nothing special, so the caller restores the bucket's
 * real material — including for `collision`, which has no renderer behind it yet.
 */
export function foliageDebugSlot(
  mode: number,
  lod: number,
  speciesIndex: number
): number | null {
  if (mode === FOLIAGE_DEBUG_LOD) return lod;
  if (mode === FOLIAGE_DEBUG_TIER) return FOLIAGE_TIER_NEAR_SLOT;
  if (mode === FOLIAGE_DEBUG_SPECIES) return speciesIndex;
  if (mode === FOLIAGE_DEBUG_CELL) return -1;
  return null;
}
