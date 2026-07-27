// Central world configuration for the DF2 terrain scaffold.
//
// Everything that will eventually be read from a real terrain's params blob
// (docs/02-asset-format-specification.md §4/§6) lives here as a constant, so that
// swapping synthetic data for extracted assets (Phase 4) is a data change,
// not a code change.

// --- World extent -----------------------------------------------------------
// The terrain is centered on the origin and spans WORLD_SIZE meters in x and z:
//   x, z ∈ [-WORLD_SIZE/2, +WORLD_SIZE/2]
export const WORLD_SIZE = 1024; // meters
export const HALF_WORLD = WORLD_SIZE / 2;

// Elevation. Synthetic fBm is normalized to [0,1] then scaled by TERRAIN_HEIGHT.
export const TERRAIN_HEIGHT = 130; // meters, peak above the field floor

// Water plane elevation (a shallow sea/lake level).
export const WATER_LEVEL = 7; // meters

// --- Chunking & LOD ----------------------------------------------------------
// The world is a CHUNK_COUNT × CHUNK_COUNT grid of square chunks.
export const CHUNK_COUNT = 16;
export const CHUNK_SIZE = WORLD_SIZE / CHUNK_COUNT; // meters per chunk edge (64)

// Segment resolutions per LOD, highest detail first. A chunk built at N
// segments has (N+1)² grid vertices. LOD 0 (64 seg) ≈ 1 m grid near the camera.
export const LOD_SEGMENTS: number[] = [64, 32, 16, 8, 4];

// Distance (meters, chunk-center to camera) at/under which each LOD is used.
// Parallel to LOD_SEGMENTS; the last entry is the fallback for everything farther.
export const LOD_DISTANCES: number[] = [110, 220, 400, 700, Infinity];

// Perimeter skirt depth used to hide cracks between differing-LOD chunks
// (docs/03-terrain-and-grass-rendering-design.md §2.3).
export const SKIRT_DEPTH = 12; // meters

// --- Heightfield sampling grid ----------------------------------------------
// Resolution of the precomputed CPU heightfield used by both the mesh builder
// and (later) the gameplay/concealment field. GRID_CELLS² cells over the world.
export const GRID_CELLS = 512; // -> 513×513 samples, 2 m spacing at WORLD_SIZE 1024
export const CELL_SIZE = WORLD_SIZE / GRID_CELLS;

// --- Atmosphere --------------------------------------------------------------
export const SKY_COLOR = "#9fb8cf";
export const FOG_COLOR = "#aac2d6";
export const FOG_NEAR = 260; // meters
export const FOG_FAR = 1500; // meters

// Sun direction (points from the scene toward the light) and camera planes.
export const SUN_DIRECTION: [number, number, number] = [-0.5, 0.72, 0.48];
export const CAMERA_NEAR = 1;
export const CAMERA_FAR = 4000;
