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
//   METERS_PER_TEXEL — horizontal spacing => world size = 1024 * this
//   HEIGHT_SCALE     — metres per raw 8-bit elevation unit (0-255)
// (1024, not 1023: the field stores 1024 distinct samples and wraps modulo, with
// no duplicated edge row — see Heightfield.ts.)
// Defaults give a ~2 km map, which puts the ~800 m concealment range at roughly
// 40% of the map width — consistent with DF2's long-range engagements.
export const METERS_PER_TEXEL = 2.0;
export const HEIGHT_SCALE = 1.0;

// --- Synthetic fallback world ------------------------------------------------
// Only used when no real terrain assets are present. Matched to the real map's
// 2 m texel so chunking, LOD and grass behave identically in both modes.
// 2048 m, matching the real map's extent (1024 texels x 2 m) so chunk size, LOD
// distances and the derived view radius come out identical in both modes. At the
// old 1024 m the fallback's 128 m chunks could not reach the fog distance.
export const WORLD_SIZE = 2048; // meters
export const TERRAIN_HEIGHT = 130; // meters, peak of the synthetic field
// Samples per side, which is also the tiling PERIOD: there is no duplicated edge
// row, every lookup wraps modulo this (Heightfield.ts).
export const GRID_CELLS = 512;

// --- Chunking & LOD ----------------------------------------------------------
// DF terrain tiles infinitely, so chunks are not a fixed grid over one map —
// they form a moving window centred on the camera (docs/06 §10). One tile is
// CHUNK_COUNT x CHUNK_COUNT chunks; the window repeats that tile outward.
export const CHUNK_COUNT = 8;

// How many chunks out from the camera to draw, in each direction. The visible
// window is (2*radius + 1)^2 chunks; frustum culling removes most.
//
// DERIVED, not fixed: Terrain.tsx computes ceil(FOG_FAR / chunkSize) and clamps
// to this cap. A fixed radius silently breaks whenever the world size changes —
// at the synthetic fallback's 128 m chunk a radius of 9 reached only 1152 m
// against a 2200 m fog distance, so the terrain ended in mid-air well inside the
// fog. Deriving it keeps the drawn extent tied to what the fog actually hides.
export const VIEW_RADIUS_MAX_CHUNKS = 12;

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
// March iterations per fragment. The step is `max(GRASS_CELL, eyeDistance *
// pixelAngle)`, so the ray advances one column width up close and roughly one
// pixel of angular size further out.
//
// SETTLED (was docs/08 §9): the earlier note here suspected the step never grew
// and capped reach at ~5.8 m, but recorded that measured behaviour disagreed. The
// measurements were taken under software rasterisation and were misleading. The
// suspicion was correct: the step was derived from `t`, the distance along the ray
// from its own start, which is zero for every fragment regardless of range, so the
// pixel term never overtook the floor. It is now derived from distance to the EYE,
// which is what the pixel-size argument was always about.
export const GRASS_STEPS = 96;
// Width of one grass column in metres — the DDA grid, deliberately decoupled
// from the 2 m terrain texel. Striations must land near screen resolution: a 2 m
// column is ~100 px wide at 10 m, which reads as mush.
//
// 0.03 is the value tools/grass-rig measured against the reference screenshots.
// The app previously shipped 0.06, which no measurement covered.
export const GRASS_CELL = 0.03;
// Metres ahead of the eye at which the march starts when standing INSIDE the
// canopy. Also the rig-measured value; the app previously passed nothing and
// silently took the material's own 0.45 default, which the material's own
// documentation says is too close to separate adjacent columns.
export const GRASS_NEAR_CLIP = 1.2;
// Bisections inside the coarse bracket. Each halves the residual error, so four
// takes a 4 m bracket to 0.25 m and a steep ray's 0.18 m bracket to 11 mm.
export const GRASS_REFINE_STEPS = 4;
// Longest span a single ray will search, metres. Only near-horizontal rays reach
// it; everything else is bounded by canopy height over the ray's vertical rate.
export const GRASS_MAX_SPAN = 48;
// Width of one tone stripe in pixels, used when the tone is keyed on ray bearing
// rather than on the world cell. Live-switchable in the ?debug=1 panel.
export const GRASS_STRIPE_PIXELS = 3;
// Metres after which the per-column hash pattern repeats.
//
// The hash wraps cell indices into a small range because a sin-based hash loses
// all precision at large arguments. That wrap was a fixed 512 CELLS, so the
// repeat distance moved with the column width — 30.7 m at 0.06 m cells, and only
// 15.4 m at the 0.03 m the rig measured, which is close enough to read as visible
// tiling at a grazing angle. Fixing the period in METRES decouples it.
export const GRASS_HASH_PERIOD = 120;
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
// Vertical field of view. Single source of truth: the grass shader derives its
// "am I scoped?" zoom factor from this, so a camera created at a different FOV
// made the unaided view read as a permanent 1.1x zoom.
export const CAMERA_FOV = 60;
// 0.05, not 1. At a 1 m near plane the ground clips away whenever the eye is
// closer to it than that — which is every crouched (0.95 m) or prone (0.35 m)
// stance — exposing the unlit back faces of the terrain and filling the view with
// black. That was recorded as an unexplained skirt artifact in docs/07 §9.
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = 8000;
/** projection[1][1] at CAMERA_FOV, the reference for the shader's zoom factor. */
export const REFERENCE_P11 = 1 / Math.tan((CAMERA_FOV * Math.PI) / 180 / 2);
