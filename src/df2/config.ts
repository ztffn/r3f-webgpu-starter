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

/**
 * The chunk grid and LOD schedule, derived ONCE.
 *
 * Both the terrain mesh (Terrain.tsx, picking each chunk's LOD) and the grass march
 * (GrassMaterial, picking which mip of the height texture to read) must land on the
 * same surface, and they do that by agreeing on these numbers. Deriving them
 * separately at each call site is how they drift — which is the bug class docs/08
 * §11 "three surfaces where there should be one" records.
 */
export function lodSchedule(worldSize: number): {
  chunkSize: number;
  lodDistances: number[];
  finestVertexSpacing: number;
} {
  const chunkSize = worldSize / CHUNK_COUNT;
  return {
    chunkSize,
    lodDistances: LOD_DISTANCE_CHUNKS.map((c) => c * chunkSize),
    // What LOD 0 actually samples at. NOT necessarily METERS_PER_TEXEL — the synthetic
    // fallback's 512-sample grid over 2048 m gives a 4 m texel against 2 m vertices.
    finestVertexSpacing: chunkSize / LOD_SEGMENTS[0],
  };
}

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
// Coarse samples actually taken per fragment — what runs, and the frame-time dial.
// GRASS_STEPS above is only the compiled ceiling the slider may sweep up to.
// Measured 8.3 ms (120 Hz vsync cap) standing AND prone at Green Mile, dpr 1, with the
// canopy forced on.
export const GRASS_STEPS_RUN = 12;
// Width of one grass column in metres — the cell grid, deliberately decoupled from the
// 2 m terrain texel. Striations must land near screen resolution: a 2 m column is
// ~100 px wide at 10 m, which reads as mush.
//
// 0.03 is the value tools/grass-rig measured against the reference screenshots. The app
// previously shipped 0.06, which no measurement covered.
//
// FIXED IN WORLD SPACE, which is the near-field weakness: a column is correct at range
// and ~90 px wide at 0.3 m. DF2 avoided this by drawing one column per SCREEN column.
// See docs/08 §9 (near-field blockiness) — the fix is the docs/03 §4.4 blade layer, not
// a smaller number here.
export const GRASS_CELL = 0.03;
// Metres ahead of the eye at which the march starts when standing INSIDE the
// canopy. Also the rig-measured value; the app previously passed nothing and
// silently took the material's own 0.45 default, which the material's own
// documentation says is too close to separate adjacent columns.
//
// This is a REQUEST, not a hard floor. The shader caps it at the midpoint of the
// ray's slab crossing, because a flat floor here starts the march past the ground
// the ray is heading for and blanks the near field prone — docs/08 §8 invariant 6.
// Raising it past about 2 m therefore stops buying anything in the near field; it
// only moves the point at which the cap takes over.
export const GRASS_NEAR_CLIP = 1.2;
// Bisections inside the coarse bracket. Each halves the residual error, so four
// takes a 4 m bracket to 0.25 m and a steep ray's 0.18 m bracket to 11 mm.
export const GRASS_REFINE_STEPS = 4;
// Longest span a single ray will search, metres. Only near-horizontal rays reach
// it; everything else is bounded by canopy height over the ray's vertical rate.
// Lowered 48 -> 28 from a visual sweep: span/steps is the step size for grazing rays, so
// this governs the horizontal layering, and 25-32 was where the crest artifact was least
// objectionable. Free in frame time — 8.3 ms at 24 and at 48, the vsync cap either way.
//
// The trade is REACH, and it touches a fairness invariant rather than just looks. Span is
// canopy height over the ray's vertical rate, so a ray at vy = 0.02 needs ~60 m to cross a
// 1.2 m canopy; at 28 anything shallower than about vy = 0.043 gives up before crossing
// and renders no grass. Watch for bald patches along near-horizontal sightlines — that is
// the renderer concealing LESS than grassHeightField says (docs/08 §8 invariant 6).
// ?maxspan= overrides it; the debug panel has it as a live slider.
export const GRASS_MAX_SPAN = 28;
// Reach, metres, for a ray that starts INSIDE the canopy — the cap's rays. Bounded
// separately from GRASS_MAX_SPAN because such a ray is already in the volume and strikes
// grass within a couple of metres, so the full reach only buys wasted samples; shortening
// it also tightens sample spacing, which is span/steps.
//
// It DOES bound reach, so it sits under docs/08 §8 invariant 6 like GRASS_MAX_SPAN: if a
// ray inside the canopy can no longer see distant grass through a gap, suspect this.
// Measured as frame-time-neutral — kept on correctness grounds, not performance ones.
export const GRASS_INSIDE_SPAN = 12;
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
// 0.78 gives a 0.44 peak-to-peak vertical ramp. The references measure a horizontal-to-
// vertical derivative ratio of ~1.6 (docs/07 §1.4), and the horizontal half is
// GRASS_TONE_VARIATION — so the two constants together encode one design quantity and
// neither can be read alone. STALE FIGURE WARNING: the ratio quoted here was 1.9 when
// the tone was 0.85; at the current 1.5 it is far higher, so the balance wants
// re-measuring against docs/07 §1.4 rather than trusting either number. It is a live
// slider because the
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

// --- Near-field blade layer (docs/03 §4.4) -----------------------------------
// A sparse layer of instanced blades OVERLAID on the relief march, not a grass field
// of its own. The march still draws the dense canopy underneath, so these supply
// silhouette in the first few metres — where a world-fixed GRASS_CELL is ~90 px wide
// and reads as tiling — and nothing else. Coverage is not their job and must not
// become it: any hole in blade coverage that replaced the march would show bare
// ground where the concealment field counts a target hidden (docs/08 §8 invariant 6).
//
// Blades are VISUAL ONLY. Concealment stays authoritative on the march and the CPU
// heightfield; nothing here is raycastable or registered with CompositeWorldQuery.

// Instance pool size. Order 4,000 — 12x smaller than the reference implementation's
// default and ~300x smaller than the other one, because neither had a march
// underneath doing the covering (docs/03 §4.4).
//
// This is the FIRST dial to turn if the layer costs too much, and it is a pool rather
// than a blade count: instances that fail the existence test collapse to a degenerate
// triangle, so the drawn count is always lower and moves with the canopy.
//
// 30,000, not the 4,000 docs/03 §4.4 proposed, and the difference is a MEASUREMENT
// rather than a preference. §4.4 sized the layer small on the assumption that blades
// are an expensive silhouette accent over a march that already covers the ground. They
// are not: measured prone at (-375, 787) with the vsync cap escaped (?dpr=2&steps=32),
// 4,000 blades cost 0.19 ms and 40,000 cost 1.46 ms against a 10.45 ms baseline —
// about 0.04 ms per thousand, linear, and dominated by nothing in particular.
//
// Buying density with count is what lets the existence test below stay honest. At 4,000
// the canopy probability had to be square-rooted to make blades visible at all on this
// map; at 30,000 the literal rule works and the fudge is gone. See docs/09 §0.2.
export const GRASS_BLADE_COUNT = 30000;
// Half-extent of the camera-following field, metres. The field is a SQUARE lattice of
// side 2x this, one blade per cell, jittered inside its own cell.
//
// A lattice rather than a random scatter, and that choice forces this number. The
// per-blade random has to be derived from the WORLD cell so a blade keeps its identity
// when the field wraps; that makes the pattern exactly stationary in world space, and
// it also makes camera-relative density impossible — near-biased placement means the
// pattern must change as you move, which is the thing being ruled out. So density is
// uniform inside the field and the near bias comes from choosing a modest extent.
//
// 6 m against §4.2's 0-15 m: the mechanic this serves — reading a gap through grass
// while prone — is decided in the first two metres of the ray, and the march still
// draws full-coverage grass beyond the field, so the edge costs nothing. At 4,000 over
// a 12 m square that is a 0.19 m cell and ~28 blades/m² everywhere in the field, where
// 4,000 over §4.4's 15 m suggestion would have given 6/m². Reach is the thing to trade
// for density here, and the sweep in the plan's task 11 is where that gets settled.
export const GRASS_BLADE_RADIUS = 6;
// Distance at which stochastic thinning starts, metres. It ends at the field extent
// by construction — there are no instances beyond it — so there is deliberately no
// second "end radius" constant to drift out of agreement with the first.
export const GRASS_BLADE_THIN_START = 2.5;
// Keep probability at the rim. Not zero: the field edge must never be a place where
// blades stop, only a place where they are rare, or the disc boundary reads as a ring.
export const GRASS_BLADE_KEEP_MIN = 0.12;
// Shaping exponent applied to the raw canopy value before it is used as the existence
// probability. 1.0 is the literal reading of docs/03 §4.4: the canopy value IS the
// probability, so bare ground grows nothing and short canopy grows sparse blades.
//
// It briefly shipped at 0.5 to compensate for a small instance pool — Green Mile's
// canopy has a MEDIAN of raw 28 of 255 (docs/06 §7.1), so the literal rule rejects
// ~89% of instances over ordinary ground and 4,000 blades became about twenty on
// screen. Measuring the layer's real cost removed the need: density now comes from the
// count, which is nearly free, rather than from bending the field's own meaning.
//
// Leave it at 1.0. Below 1.0 this layer starts describing a canopy the march does not
// draw and the concealment query does not know about, which is the third-representation
// failure docs/03 §4.4 names as its one hard constraint.
export const GRASS_BLADE_DENSITY_GAMMA = 1.0;
// Blade width at the root, metres, at height scale 1. About 1.7 GRASS_CELL columns,
// so a blade is a little wider than the columns it stands among — wide enough to
// read as an edge against the sky, narrow enough not to be a plank. Scales with the
// instance's own height so short blades are not squat.
export const GRASS_BLADE_WIDTH = 0.05;
// Multiplier on the march's own column height. 1.0 means a blade stands EXACTLY as
// tall as the columns around it, which is the whole point of deriving height from
// canopyBase rather than from a free parameter — a value away from 1.0 reintroduces
// the height seam this layer exists to hide. Kept as a constant only so the seam can
// be made visible on purpose when checking that the two layers agree.
export const GRASS_BLADE_HEIGHT_SCALE = 1.0;
// Base-to-tip brightness at a BLADE's root; the tip gets 2 - this. The march's own
// columns use GRASS_SHADE_BASE (0.78, a 0.44 swing); blades get a wider one.
//
// Not a lighting model and not a brightening. A blade only reads as a blade when it
// separates from the canopy mass behind it, and what separates it is CONTRAST along
// its own length: dark at the root where it sits inside the mass, bright at the tip
// where a real blade catches sky. Widening the ramp buys that while keeping the colour
// anchored to the colormap, so a blade over a dark patch is still dark.
//
// 0.55 gives a 0.9 swing, roughly double the march's. Raising it much past that starts
// clipping to white in already-bright colormap patches and implies a light source the
// rest of this renderer does not have — every material here is unlit because the
// colormap is pre-shaded. Sweep it with `?bladeshade=`.
export const GRASS_BLADE_SHADE_BASE = 0.55;
// Brightness multiplier on a blade's colour, on top of the ramp above.
//
// The ramp is CONTRAST along one blade; this is the blade layer against the march
// behind it. Both are needed and they are not the same dial: widening the ramp alone
// darkens roots as much as it brightens tips, so the layer as a whole stays as dark as
// the canopy and reads as texture rather than as blades.
//
// Physically the right sign, which is why it is not a cheat. The colormap is
// pre-shaded GROUND, and ground under grass is shadowed by the grass standing on it —
// so a blade tip held above the canopy is genuinely lit more than the texel it grows
// from. Lifting blades above the map is closer to correct than matching it.
//
// 2.0 was settled by looking, against a predicted ceiling of about 1.6 where bright
// colormap patches were expected to clip to white. They do not, because the ramp above
// multiplies in: a blade's ROOT sits at 0.55 x 2.0 = 1.1 and only its tip reaches
// 1.45 x 2.0 = 2.9, and tips are a small fraction of the covered pixels. Read the two
// constants together or neither means anything. Sweep it with `?bladelift=`.
export const GRASS_BLADE_LIFT = 2.0;
// Rings minus one along the blade. 3 segments is 4 rings, 10 vertices, 10 triangles;
// the reference uses 5, but its blades are a metre tall in isolation while ours are
// ankle height over most of this map and cannot show that much curvature.
export const GRASS_BLADE_SEGMENTS = 3;
// How far the centre vertex is pushed along the blade's local depth axis, as a
// fraction of that ring's own (already tapered) width. The reference uses 0.5, a 45
// degree V that reads as a rounded modern blade. 0.3 keeps DF2's near-flat columnar
// identity while still catching a different shade from each half.
export const GRASS_BLADE_V_DEPTH = 0.3;
// Resting lean, as a fraction of the blade's own height, peak to peak. Every blade
// gets a fixed bend in a fixed direction so a windless field is not a bed of nails;
// the reference's equivalent is (rand-0.5)*2.5 against a unit-height blade, which is
// far more lean than DF2's near-vertical striations can carry.
export const GRASS_BLADE_BEND = 0.35;
// Twist of the cross-section about the blade's own axis, radians at the tip, peak to
// peak. Stops a near-flat blade reading as a flat card when seen edge-on. Straight
// from the reference (seed * 2.5 * uv.y), which is one of the few of its numbers that
// transfers unchanged, since it is about the primitive rather than about the field.
export const GRASS_BLADE_TWIST = 2.5;
// Tip displacement in metres per metre of blade height, per m/s of wind, before the
// noise term scales it down. At the default 4 m/s that is a tip lean of ~0.24 of the
// blade's height, which reads as a stiff breeze without the field looking liquid.
//
// The DIRECTION is not tunable and must not become so: it comes from
// BallisticEnvironment.windVelocity, which drifts bullets, so grass is the instrument
// a shooter reads for windage (docs/03 §4.4). A free direction here would make the
// instrument lie.
export const GRASS_BLADE_WIND_GAIN = 0.06;
// Metres of noise lattice per metre of world, i.e. the size of a gust. 0.48 from the
// reference: gusts about 2 m across, which is the scale that reads as air moving over
// grass rather than as the whole field breathing.
export const GRASS_BLADE_NOISE_SCALE = 0.48;
// How fast the noise field drifts, in lattice units per second per m/s of wind. At
// 4 m/s and the scale above this walks a gust across the ground at ~0.5 m/s — slower
// than the wind itself, which is correct: what travels is the gust pattern, not the air.
export const GRASS_BLADE_GUST_RATE = 0.06;

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
