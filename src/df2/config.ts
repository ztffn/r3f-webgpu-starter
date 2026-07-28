// Central world configuration for the DF2 terrain renderer.
//
// Everything that will eventually be read from a real terrain's params blob
// (docs/02-asset-format-specification.md §4/§6) lives here as a constant, so that
// swapping synthetic data for extracted assets is a data change, not a code change.

// --- Which terrain to load ---------------------------------------------------
// Looks for /assets/terrain/<slug>/terrain.json (prepared by tools/df2-extract).
// If absent, the renderer falls back to synthetic fBm terrain.
export const TERRAIN_SLUG = "gmile"; // EXP2b "Green Mile"

// --- Real-map scale (UNCALIBRATED — see docs/01 §7) --------------------------
// DF terrain images are 1024x1024. These two constants convert that grid into
// world units and are the main "does it feel right" dials:
//   METERS_PER_TEXEL — horizontal spacing => world size = 1023 * this
//   HEIGHT_SCALE     — metres per raw 8-bit elevation unit (0-255)
// Defaults give a ~2 km map, which puts the ~800 m concealment range at roughly
// 40% of the map width — consistent with DF2's long-range engagements.
export const METERS_PER_TEXEL = 2.0;
export const HEIGHT_SCALE = 1.0;

// --- Synthetic fallback world ------------------------------------------------
// Only used when no real terrain assets are present.
export const WORLD_SIZE = 1024; // meters
export const HALF_WORLD = WORLD_SIZE / 2;
export const TERRAIN_HEIGHT = 130; // meters, peak of the synthetic field
export const GRID_CELLS = 512; // -> 513x513 samples
export const CELL_SIZE = WORLD_SIZE / GRID_CELLS;

// --- Chunking & LOD ----------------------------------------------------------
// DF terrain tiles infinitely, so chunks are not a fixed grid over one map —
// they form a moving window centred on the camera (docs/06 §10). One tile is
// CHUNK_COUNT x CHUNK_COUNT chunks; the window repeats that tile outward.
export const CHUNK_COUNT = 8;

// How many chunks out from the camera to draw, in each direction. The visible
// window is (2*VIEW_RADIUS_CHUNKS + 1)^2 chunks; frustum culling removes most.
// At a ~256 m chunk this reaches ~2.3 km, matching FOG_FAR.
export const VIEW_RADIUS_CHUNKS = 9;

// Segment resolutions per LOD, highest detail first. A chunk built at N segments
// has (N+1)^2 grid vertices. At 128 segments over a ~256 m chunk the vertex
// spacing matches the source heightmap's 2 m texel spacing exactly.
export const LOD_SEGMENTS: number[] = [128, 64, 32, 16, 8];

// LOD switch distances, expressed in CHUNK WIDTHS from the camera so they scale
// with the map. Parallel to LOD_SEGMENTS; last entry catches everything beyond.
export const LOD_DISTANCE_CHUNKS: number[] = [1.2, 2.5, 4.5, 8, Infinity];

// Perimeter skirt depth used to hide cracks between differing-LOD chunks
// (docs/03-terrain-and-grass-rendering-design.md §2.3).
export const SKIRT_DEPTH = 12; // meters

// --- Grass (docs/07-grass-visual-reference.md) --------------------------------
// Metres per raw canopy unit. Raw 255 therefore stands GRASS_SCALE*255 tall.
// 0.004 puts the TALLEST canopy near 1 m — waist height on a 1.8 m soldier,
// which is what the reference screenshots show (docs/07 §2). Keeping the canopy
// below standing eye height also matters mechanically: above it, the camera sits
// inside the volume and the view fills with the column it occupies.
export const GRASS_SCALE = 0.0047;
// DDA cells walked per fragment. Each step crosses exactly one heightmap texel
// (~2 m), so this is also the reach of exactly-resolved columns (~96 m). The
// original algorithm is trivial for modern GPUs — per-pixel raycasting against a
// 2D array is not where the cost is — so this is budgeted generously.
export const GRASS_STEPS = 96;
// Width of one grass column in metres — the DDA grid, deliberately decoupled
// from the 2 m terrain texel. Striations must land near screen resolution: a 2 m
// column is ~100 px wide at 10 m, which reads as mush. Measured against the
// references, sub-metre cells took horizontal variation from |dx| 0.17 to 2.05
// (reference 2.80).
export const GRASS_CELL = 0.06;
// Peak-to-peak per-column tone variation. Neighbouring sub-metre columns sample
// almost the same colormap texel, so nearly all the horizontal "corduroy" the
// references show has to come from this.
export const GRASS_TONE_VARIATION = 0.85;
// Columns fade into the colormap between these distances (m). Beyond ~150 m a
// column is sub-pixel anyway, and the colormap is already grass-coloured at 100%
// coverage, so the handover is invisible and coverage never appears to thin.
// NOTE: 800 m concealment does NOT depend on this — that is a gameplay query
// against grassHeightField (docs/04), computed analytically, not from pixels.
export const GRASS_FADE_START = 700;
export const GRASS_FADE_END = 1100;

// --- Atmosphere --------------------------------------------------------------
export const SKY_COLOR = "#9fb8cf";
export const FOG_COLOR = "#aac2d6";
export const WATER_COLOR = "#2a4a63";
export const FOG_NEAR = 300; // meters
export const FOG_FAR = 2200; // meters

// Sun direction (points from the scene toward the light) and camera planes.
export const SUN_DIRECTION: [number, number, number] = [-0.5, 0.72, 0.48];
export const CAMERA_NEAR = 1;
export const CAMERA_FAR = 8000;
