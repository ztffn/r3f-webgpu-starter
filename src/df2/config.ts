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
// Passes of a [1,2,1] binomial filter used to reconstruct the sub-unit relief that
// 8-bit elevation storage quantised away. 0 keeps the raw surface.
//
// The heightmap has 256 levels, so the smallest representable step is one raw unit —
// 1 m at the scale above, across a 2 m texel, which is a 26.6 degree facet. Measured on
// Green Mile the MEDIAN facet angle is exactly 26.6 degrees and 48% of adjacent samples
// are identical: the surface is step-flat-step-flat. That terracing is a storage
// artifact, and it is what makes the terrain read as jagged rather than as the soft
// rolling relief DF2 showed (docs/07 §9).
//
// 2 passes clears the 2-texel terracing while leaving the tens-of-metres features that
// carry the terrain's shape. Raising it flattens real relief; 0 shows the raw data,
// which is the honest A/B for judging this.
export const HEIGHT_SMOOTH_PASSES = 2;

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
// COARSE BRACKET SAMPLES per fragment — the single dial that sets frame time, since
// cost is very close to linear in it (docs/09 §2).
//
// Was 96, and that was a STALE UNIT rather than a tuning choice. 96 was the budget for
// the old adaptive march, which took many tiny steps until it hit something. The
// bracket-and-bisect rewrite redefined `steps` as samples spread across a computed span
// and its own default is 12 — but this constant was never updated, so the app ran 96
// coarse samples plus 4 bisections where the design intends 16 samples total.
//
// Measured at Green Mile (5, 375) standing, dpr 1: 19.6 ms at 96, 7.8 ms at 12 — and
// 7.8 ms is at the 120 Hz vsync cap, so the true cost is lower again. No visible loss of
// grass density or silhouette at that vantage.
//
// The risk of lowering it is stepping OVER a thin column and missing it, which shows as
// sparse patches at grazing angles rather than as a general dimming. Check prone and
// along a ridge before lowering further.
//
// GRASS_STEPS_RUN below is what actually runs. This is now the COMPILED CEILING, not the running value: the loop is compiled at this
// count and runs to the live `steps` uniform, so the debug slider can sweep 1..this
// without a rebuild. 32 leaves headroom to sweep; the shipped running value is the
// slider's default, which seeds from this.
export const GRASS_STEPS = 32;
// Width of one grass column in metres — the DDA grid, deliberately decoupled
// from the 2 m terrain texel. Striations must land near screen resolution: a 2 m
// column is ~100 px wide at 10 m, which reads as mush.
//
// 0.03 is the value tools/grass-rig measured against the reference screenshots.
// The app previously shipped 0.06, which no measurement covered.
// Coarse samples actually taken per fragment — what runs, and the frame-time dial.
// GRASS_STEPS above is only the compiled ceiling the slider may sweep up to.
// Measured 8.3 ms (120 Hz vsync cap) standing AND prone at Green Mile (5, 375), dpr 1.
export const GRASS_STEPS_RUN = 12;
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
export const GRASS_TONE_VARIATION = 1.5;
// Brightness at a column's BASE; the tip gets 2 - this, so the ramp is centred on
// 1.0 and grass keeps the average brightness of the terrain under it.
//
// 0.78 gives a 0.44 peak-to-peak vertical ramp against the tone's 0.85 horizontal,
// an h/v ratio near 1.9 — the references measure ~1.6 (docs/07 §1.4), so this is in
// the right neighbourhood while staying clear of blowing out the brighter colormap
// texels once the tone multiplier stacks on top. It is a live slider because the
// vertical/horizontal balance is the thing that decides whether this reads as DF2
// grass, and that is settled by looking, not by argument.
export const GRASS_SHADE_BASE = 0.78;
// Share of the baked HEIGHT field carried by noise at texel resolution (0.117 m),
// which is the finest detail that texture can express — about four strands wide at
// the default 0.03 m column.
//
// Without it the canopy top rolls in clumps: the field's finest fbm term is at 0.35 m,
// roughly twelve strands, so neighbouring strands were near the same height. The DF2
// references show a ragged edge varying strand to strand (docs/07 §1.3).
//
// Bake-time, so `?strand=` overrides it and a reload is needed. Kept modest because the
// march samples column height 12 times over metres, and a one-texel spike is exactly
// what it can step over — too much here buys shimmer under motion, not detail.
export const GRASS_STRAND_JITTER = 0.18;
// Share of column height and tone taken from the per-CELL arithmetic hash rather than
// the metre-mapped jitter texture.
//
// The texture cannot resolve a strand: one texel is 0.117 m, so four columns share a
// height at the 0.03 m default and twenty-three at 0.005 m — thinning the column only
// widened the banding. Sampling that texture per cell instead fixed the look and HALVED
// the frame rate, because the march evaluates column height at 16 samples per fragment
// and each one then missed the texture cache (docs/07 §9).
//
// So the fine term is arithmetic instead: ~6 ALU ops, no memory traffic, mixed against
// the texture's coarse clumping. Live slider — it trades strand detail against nothing
// much, so raise it if thin columns still look banded.
export const GRASS_STRAND_MIX = 0.35;
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
export const FOG_FAR = 2200;

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
