// Vegetation constants — bushes and trees, not grass.
//
// Grass is the columnar march (docs/03 §4.1, src/df2/GrassMaterial.ts). This is the
// layer above it: discrete objects with silhouettes, which is a completely different
// cost structure — grass costs screen pixels, foliage costs draw calls, overdraw and
// alpha-tested fragments.
//
// EVERY NUMBER HERE IS A STARTING VALUE TO BE BENCHMARKED, not a derived constant.
// The research this module was built from cites Frostbite's 16 m undergrowth cells;
// that is a 2007 value for a different system on different hardware and copying it
// would be folklore. The values below are chosen so they NEST in structures the
// project already has, which makes them defensible starting points and nothing more:
//
//   FOLIAGE_CELL = 32 m  = one eighth of a 256 m terrain chunk (docs/08 §6.2), and
//                          also the world-query collider cell (WorldQuery.ts), so a
//                          ballistic ray and a render bucket walk the same grid.
//
// See docs/plans/2026-08-02-foliage-vegetation-design.md §7 for the sweep protocol.

/**
 * Side of one vegetation cell, metres.
 *
 * Sets four things at once, which is why it has to be swept rather than reasoned about:
 * draw-call count (buckets scale as radius²/cell²), frustum-culling granularity (a cell
 * is one InstancedMesh with one bounding sphere — a visible corner keeps the whole cell
 * alive), LOD granularity (a cell takes ONE LOD, so error at a switch boundary is up to
 * half a cell diagonal), and placement-hash locality.
 */
export const FOLIAGE_CELL = 32;

/**
 * Metres between candidate placement sites. A cell is divided into a lattice at this
 * spacing and each subcell gets one jittered candidate, accepted or rejected by density.
 *
 * Stratified rather than uniform-random because uniform random clumps, and clumped cover
 * reads as unfair rather than as natural (docs/00 pillar 5).
 *
 * IN METRES, NOT SITES PER CELL, and that distinction was a bug before it was a comment.
 * A fixed site count per cell makes plant density a function of CELL SIZE: the first
 * clean cell-size sweep put 8361 plants inside 192 m at a 16 m cell and 302 at a 128 m
 * cell, a 28x difference in how much cover the map grows. Cell size is a rendering
 * parameter and must not be able to touch gameplay.
 */
export const FOLIAGE_SITE_SPACING = 5.33;

/** Global multiplier on every species' density. `?foliagedensity=` overrides it. */
export const FOLIAGE_DENSITY = 1;

/**
 * Radius of the maintained cell window, in METRES rather than cells.
 *
 * Not a cosmetic difference. Expressed in cells, changing `FOLIAGE_CELL` also changes how
 * far vegetation is drawn, so a cell-size sweep would move two variables at once and its
 * draw-call numbers would mean nothing — measured, on the first sweep run: 16 m cells
 * reached 96 m and 64 m cells reached 384 m while both reported ~400 buckets. In metres,
 * the reach is held and the sweep isolates what it is meant to.
 *
 * Impostor-only rings beyond this are NOT yet built; this prototype draws geometry to the
 * window edge and nothing past it.
 */
export const FOLIAGE_VIEW_RADIUS_METRES = 192;

/**
 * Distance (m) at which a cell drops to each LOD, measured to the cell CENTRE.
 *
 * Parallel to the species' LOD tiers, last entry catches everything beyond. Distance
 * rather than projected screen size for the FIRST implementation only: the memo's
 * screen-size argument is correct (a 12 m tree and a 0.8 m shrub must not switch at
 * the same distance) and species-relative distances below encode exactly that, scaled
 * per species by `lodScale`, which is projected size with the camera term factored out
 * and held constant. It stops being equivalent the moment FOV changes — a scope makes
 * everything bigger on screen without moving it — so `FoliageCells` applies the same
 * zoom factor the grass march uses (docs/08 §6.4).
 */
export const FOLIAGE_LOD_DISTANCES = [45, 110, 240, Infinity];

/**
 * Fractional hysteresis on a LOD switch: a cell must move 12% further out to drop a
 * level than it needed to gain one. Without it a cell sitting exactly on a boundary
 * flips every frame as the camera breathes, and a flip is a visible pop.
 */
export const FOLIAGE_LOD_HYSTERESIS = 0.12;

/**
 * Per-frame millisecond budget for building cell instance data and uploading buffers.
 * Same device as Terrain.tsx's BUILD_MS and for the same reason: a cold window is
 * hundreds of cells and doing them all in one frame is a visible stall.
 */
export const FOLIAGE_BUILD_MS = 3;

/** Alpha-test cutoff for every foliage material. Matches glTF MASK's default. */
export const FOLIAGE_ALPHA_CUTOFF = 0.5;

/**
 * Peak horizontal sway of a leaf card at full height, metres, and the wind's period.
 *
 * Bounded deliberately: the fairness rule from the research memo is that wind must not
 * open and close large holes in cover, because two clients at different frame times
 * would then disagree about what is visible. Small amplitude and a long period keep
 * the concealment envelope effectively static while still reading as motion.
 */
export const FOLIAGE_WIND_AMPLITUDE = 0.16;
export const FOLIAGE_WIND_PERIOD_SECONDS = 4.7;

/** Metres over which a cell's foliage fades out at the window edge. */
export const FOLIAGE_FADE_METRES = 24;

/**
 * Write four floats into `dst` at vec4 slot `index`.
 *
 * Exists because WebGPU's eight-vertex-buffer ceiling forces packing in TWO places — the
 * per-vertex card data in `foliageGeometry` and the per-instance transform in
 * `FoliageCells` — and both were doing the same `dst[i * 4 + n]` arithmetic by hand.
 */
export function packVec4(
  dst: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  w: number
): void {
  const base = index * 4;
  dst[base] = x;
  dst[base + 1] = y;
  dst[base + 2] = z;
  dst[base + 3] = w;
}
