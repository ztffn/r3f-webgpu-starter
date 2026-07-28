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
// The world is a CHUNK_COUNT x CHUNK_COUNT grid of square chunks. Chunk size is
// derived from the active heightfield's world size, so this works for both the
// synthetic and real-map paths.
export const CHUNK_COUNT = 16;

// Segment resolutions per LOD, highest detail first. A chunk built at N segments
// has (N+1)^2 grid vertices. At 64 segments over a ~128 m chunk the vertex
// spacing matches the source heightmap's 2 m texel spacing exactly.
export const LOD_SEGMENTS: number[] = [64, 32, 16, 8, 4];

// LOD switch distances, expressed in CHUNK WIDTHS from the camera so they scale
// with the map. Parallel to LOD_SEGMENTS; last entry catches everything beyond.
export const LOD_DISTANCE_CHUNKS: number[] = [1.5, 3, 6, 11, Infinity];

// Perimeter skirt depth used to hide cracks between differing-LOD chunks
// (docs/03-terrain-and-grass-rendering-design.md §2.3).
export const SKIRT_DEPTH = 12; // meters

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
