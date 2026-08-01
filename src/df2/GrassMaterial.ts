// Columnar grass — the "authentic mode" grass shader.
//
// WHAT THIS REPRODUCES (docs/07-grass-visual-reference.md)
// DF2's grass is not blades. Voxel Space painted, per screen column, a solid
// vertical span from the ground up to `terrain + stretch`, coloured from the
// column's own ground texel. The result reads as hard-edged VERTICAL STRIATIONS
// with total coverage that never thins with distance.
//
// HOW
// We render a shell — the terrain surface lifted by the maximum canopy height —
// and, per fragment, march the view ray down through the volume between the
// shell and the ground. At each step we ask the same question the original did:
// "is this point below the top of the grass column standing here?" On the first
// yes we shade; if the ray reaches the ground without a hit we discard and the
// terrain colormap shows through.
//
// Two details carry the look, and both are deliberate:
//   1. Discreteness comes from the shader's own grass-cell grid, not from texture
//      filtering. The canopy field is sampled LINEARLY on purpose — it is the
//      envelope (where grass grows, roughly how tall), and sampling it NEAREST
//      just stamps the 2 m terrain texel onto the canopy as visible blocks. The
//      hard vertical edges come from quantising the march position to a cell and
//      giving that cell its own height (see loadTerrain.makeGrassTexture).
//   2. Colour is fetched at the HIT COLUMN's quantised texel — one colour per
//      column, smeared up its full height. Sampling colour per-step along the
//      ray instead would read as soft modern grass, not DF2 grass (docs/07 §1.1).

import * as THREE from "three/webgpu";
import {
  Fn,
  Loop,
  Break,
  If,
  float,
  vec2,
  vec3,
  vec4,
  uniform,
  texture,
  positionLocal,
  positionWorld,
  modelWorldMatrix,
  cameraPosition,
  cameraViewMatrix,
  cameraNear,
  cameraFar,
  cameraProjectionMatrix,
  screenSize,
  viewZToPerspectiveDepth,
  struct,
} from "three/tsl";

/**
 * Margin the shell is lifted above the smooth canopy envelope.
 *
 * Load-bearing in TWO places that must agree: the vertex lift here, and Terrain.tsx's
 * test for whether the eye is inside the canopy (which decides if the cap is drawn).
 * Drifting them apart silently drops the cap where it is needed, and with it every
 * ray that starts inside the volume.
 */
export const CANOPY_MARGIN = 1.04;

export interface GrassMaterialOptions {
  /** Per-texel canopy height, 0-255. LINEAR-filtered — this is the envelope. */
  grassMap: THREE.Texture;
  /**
   * Baked per-column jitter (R) and tone (G), tiling over `hashPeriod` metres.
   *
   * The march evaluates the jittered column height at every sample, so this has to
   * be one fetch. Computing it from a sin hash instead cost ~87% of the whole grass
   * pass (99.8 ms against 12.57 ms for the same sample count). See grassJitter.ts.
   */
  jitterMap: THREE.Texture;
  /**
   * Terrain elevation, mip chain point-decimated to the terrain MESH's LOD lattice
   * (heightTexture.ts). The march picks its level with `chunkSize`/`lodDistances`.
   */
  heightMap: THREE.Texture;
  /** Chunk width in metres — the unit LOD switch distances are expressed in. */
  chunkSize: number;
  /**
   * Metres between adjacent MESH vertices at LOD 0 (`chunkSize / LOD_SEGMENTS[0]`).
   *
   * Only equals `texelSize` when the finest mesh happens to sample every texel. The
   * march needs both to work out which mip corresponds to which mesh LOD — see
   * `meshMipAt`.
   */
  finestVertexSpacing: number;
  /**
   * Metres between adjacent heightfield samples (`Heightfield.cellSize`).
   *
   * Needed to undo the half-texel offset between the two interpolation conventions:
   * `Heightfield.sample` interpolates between grid NODES, node i at grid coordinate i,
   * while GPU bilinear interpolates between texel CENTRES, at i + 0.5.
   */
  texelSize: number;
  /**
   * LOD switch distances in METRES, in the order Terrain.tsx applies them.
   *
   * Both sides derive these from `LOD_DISTANCE_CHUNKS`; that shared origin is what
   * stops the mesh and the march landing on different surfaces. The CPU's trailing
   * Infinity is ignored here — it only exists to catch everything beyond the last.
   */
  lodDistances: number[];
  /** Colormap — the source of each column's colour. */
  colorMap: THREE.Texture;
  /** Metres spanned by one tile of the maps. */
  worldSize: number;
  /** Metres per raw canopy unit — how tall "255" grass stands. */
  grassScale: number;
  /**
   * Coarse bracket samples per fragment. Cost is very close to linear in this
   * (docs/09), so it is the single dial that sets frame time.
   */
  steps?: number;
  /**
   * Coarse samples actually taken, defaulting to `steps`. `steps` is the COMPILED
   * ceiling; this is what runs, and it is live on a uniform so the debug slider can
   * sweep without rebuilding the material.
   */
  stepsRun?: number;
  /** Bisections inside the bracket. Each one halves the residual error. */
  refineSteps?: number;
  /**
   * Longest span a ray will search, metres. The span is normally set by the view
   * angle — canopy height over the ray's vertical rate — which is what determines
   * how far a ray must travel to cross the canopy. A near-horizontal ray would
   * want an unbounded span, so it is clamped here and gives up beyond it.
   */
  maxSpan?: number;
  /**
   * Reach, metres, for a ray that starts INSIDE the canopy — the eye is already in
   * the volume, so grass here is struck within a couple of metres and the full
   * `maxSpan` only buys repeated marches over the same near column.
   */
  insideSpan: number;
  /** Width of one tone stripe in pixels, when toneMode is 1. */
  stripePixels?: number;
  /** 0 = tone keyed on the world cell (shipped), 1 = keyed on ray bearing. */
  toneMode?: number;
  /**
   * Scene fog, applied by this material rather than by three.
   *
   * three fogs a fragment by its RASTERISED depth, which for this material is the
   * shell — and the shell is nowhere near where the ray actually hit. Standing
   * inside the canopy the hit is metres away while the shell fragment can be
   * hundreds of metres out, so near grass came out washed pale with fog it should
   * not have had. Same class of error as depthNode exists to fix.
   */
  fogColor?: THREE.ColorRepresentation;
  fogNear?: number;
  fogFar?: number;
  /**
   * Width of one grass column in metres — the DDA grid, decoupled from the
   * heightmap texel. DF2's striations are far finer than its 1024² heightmap:
   * the detail texture tiled at a much smaller scale, so canopy height varied
   * sub-metre and adjacent screen columns painted different heights. Using the
   * 2 m texel as the column width gives ~100 px columns at 10 m — mush, not
   * corduroy. Sub-metre cells put striations near screen resolution.
   */
  cellSize?: number;
  /**
   * Peak-to-peak per-column tone variation (0-1). With sub-metre columns and a
   * 2 m colormap texel, neighbouring columns sample almost the same map colour,
   * so nearly all horizontal variation — the 'corduroy' the references show —
   * has to come from this.
   */
  toneVariation?: number;
  /**
   * Brightness at a column's BASE, relative to its colormap colour. The tip gets
   * `2 - shadeBase`, so the ramp stays centred on 1.0 and grass keeps the average
   * brightness of the terrain it stands on.
   *
   * This exists because the vertical ramp was previously produced by accident. The
   * `.mix()` argument rotation (§11 of docs/08) turned an intended 0.88-1.05 into an
   * effective 0.13-1.00, and that strong ramp was supplying nearly all the visible
   * column structure. Correcting the rotation removed it, and the intended near-flat
   * ramp had nothing to replace it with. The references do want vertical variation,
   * just less than horizontal — measured h/v derivative ratio ≈ 1.6 (docs/07 §1.4) —
   * so the two have to be dialled against each other rather than one assumed away.
   */
  shadeBase?: number;
  /**
   * Debug: ignore the canopy field and grow full-height grass EVERYWHERE.
   *
   * Green Mile's canopy is a colormap-derived stand-in, so it is patchy and a frame can
   * legitimately be mostly bare. That makes shader problems and missing canopy look the
   * same. Live-togglable; never measure with it on.
   */
  canopyForce?: boolean;
  /**
   * Metres ahead of the eye at which the march begins when standing INSIDE the
   * canopy.
   *
   * Prone in grass you should see only grass — that symmetry (concealed means
   * blind) is the mechanic, not a bug. But the fill has to read as grass, and
   * starting at the eye makes every ray hit the same column: at 2 cm range
   * adjacent pixels diverge by ~0.1 mm, so no column width can separate them and
   * the screen resolves to one flat colour. Beginning the march a little way out
   * puts hits where columns actually subtend a few pixels.
   *
   * A REQUEST, not a hard floor — capped at the midpoint of the ray's slab crossing
   * where the two would conflict. Applied flat it starts the march past the ground
   * the ray is heading for, which blanks the near field prone; see the entry rule
   * below and docs/08 §8 invariant 6.
   */
  nearClip?: number;
  /** Distance (m) at which columns start fading into the colormap. */
  fadeStart?: number;
  fadeEnd?: number;
  /**
   * Metres after which the per-column hash pattern repeats.
   *
   * Cell indices must be wrapped into a small range before hashing, because a
   * sin-based hash loses all precision at large arguments. Wrapping at a fixed
   * CELL COUNT tied the repeat distance to the column width, so making columns
   * finer also made the tiling more obvious. Fixing it in metres decouples them.
   */
  hashPeriod?: number;
  /**
   * Share of column HEIGHT taken from the per-cell arithmetic hash rather than the
   * metre-mapped texture, 0-1.
   *
   * Height is evaluated at every march sample, so this is the only visual dial with a
   * real frame-time cost; 0 lets the compiler fold it away entirely. Per-column TONE
   * always uses the hash regardless, because it is evaluated once at the hit and is
   * therefore free — and tone is what makes thin columns read as thin.
   */
  strandMix?: number;
  /**
   * projection[1][1] for the unaided view, i.e. 1/tan(fovY/2) at the camera's
   * base field of view. The zoom factor is measured against this, so it MUST
   * match the camera actually in use or every frame reads as partly zoomed.
   */
  referenceP11?: number;
}

/**
 * Live-tunable graph inputs.
 *
 * Exposed so a debug panel can drive them by assigning `.value`, which costs no
 * material rebuild — and rebuilding the material would discard the terrain
 * geometry cache along with it (Terrain.tsx). Anything NOT here is baked into the
 * graph at construction: the two loop counts, and the hash wrap period derived
 * from cellSize. Those need a reload, so they come from the URL instead.
 */
export interface GrassUniforms {
  /**
   * Tallest possible canopy, metres — `grassScale * 255`.
   *
   * The ONE canopy-height uniform: it scales the 0-1 canopy field into metres and it
   * sets how far a ray must travel to cross the volume. There is no `grassScale`
   * uniform to keep it in step with any more; that pairing was two nodes holding the
   * same number, kept equal by hand from the debug panel.
   */
  canopyMax: ReturnType<typeof uniform>;
  cell: ReturnType<typeof uniform>;
  tone: ReturnType<typeof uniform>;
  /** Column-base brightness; the tip gets 2 - this, so the ramp centres on 1.0. */
  shadeBase: ReturnType<typeof uniform>;
  /** Live coarse sample count, capped by the compiled `steps`. The frame-time dial. */
  steps: ReturnType<typeof uniform>;
  /** Per-strand detail from the ALU hash vs the metre-mapped texture, 0-1. */
  strandMix: ReturnType<typeof uniform>;
  /** Debug: 1 grows full-height grass everywhere, ignoring the canopy field. */
  canopyForce: ReturnType<typeof uniform>;
  toneMode: ReturnType<typeof uniform>;
  stripePixels: ReturnType<typeof uniform>;
  nearClip: ReturnType<typeof uniform>;
  maxSpan: ReturnType<typeof uniform>;
  fadeStart: ReturnType<typeof uniform>;
  fadeEnd: ReturnType<typeof uniform>;
  debugMode: ReturnType<typeof uniform>;
}

export interface GrassMaterial {
  /**
   * Ceiling proxy: the terrain surface lifted to the local canopy top, FRONT FACES
   * ONLY. It answers rays arriving from outside the volume.
   */
  material: THREE.MeshBasicNodeMaterial;
  /**
   * Cap: one screen-covering proxy, drawn only while the eye is INSIDE the canopy,
   * whose march starts at the eye.
   *
   * REPLACES the per-chunk floor proxy. Both exist for the same reason — inside the
   * canopy a ray is already in the volume at s = 0, so no surface of that volume marks
   * where it entered — but the floor answered it with geometry per chunk, which meant a
   * single pixel could be covered by several proxies and march several times over. That
   * measured 33.3 ms against 8.5 ms once the entry rule was corrected. One cap is one
   * march per pixel, which is all that case ever needed.
   *
   * It is a RASTERISATION TRIGGER, not something visible: its only job is to give the
   * pixel a fragment so the march runs. Coverage, gaps and how far you can see through
   * the canopy are all still resolved per pixel by the march itself.
   */
  capMaterial: THREE.MeshBasicNodeMaterial;
  uniforms: GrassUniforms;
}

export function createGrassMaterial(opts: GrassMaterialOptions): GrassMaterial {
  const {
    grassMap,
    jitterMap,
    heightMap,
    chunkSize,
    texelSize,
    finestVertexSpacing,
    lodDistances,
    colorMap,
    worldSize,
    grassScale,
    steps: coarseSteps = 12,
    stepsRun,
    refineSteps = 4,
    maxSpan = 48,
    insideSpan,
    stripePixels = 3,
    toneMode = 0,
    fogColor = "#aac2d6",
    fogNear = 300,
    fogFar = 2200,
    cellSize = 0.35,
    nearClip = 1.2,
    toneVariation = 0.42,
    shadeBase = 0.78,
    canopyForce = false,
    fadeStart = 420,
    fadeEnd = 700,
    hashPeriod = 120,
    strandMix = 0.5,
    // 1/tan(30 deg): a 60-degree vertical FOV, matching config.CAMERA_FOV.
    referenceP11 = 1 / Math.tan((60 * Math.PI) / 180 / 2),
  } = opts;

  // Cell indices are wrapped to this many cells before hashing. Derived from the
  // requested metric period so the repeat distance does not move with cellSize.
  const hashWrapCells = Math.max(64, Math.round(hashPeriod / cellSize));

  const canopyMax = 255 * grassScale;

  const uWorldSize = uniform(worldSize);
  const uHalfWorld = uniform(worldSize / 2);
  const uCell = uniform(cellSize); // metres per grass column
  const uNearClip = uniform(nearClip);
  const uMaxSpan = uniform(maxSpan);
  /** Reach for a ray that starts inside the canopy. See the note beside `span`. */
  const uInsideSpan = uniform(insideSpan);
  const uStripePixels = uniform(stripePixels);
  const uHashPeriod = uniform(hashPeriod);
  /** Per-strand HEIGHT from the hash vs the texture. The one dial that costs. */
  const uStrandMix = uniform(strandMix);
  const uFogColor = uniform(new THREE.Color(fogColor));
  const uFogNear = uniform(fogNear);
  const uFogFar = uniform(fogFar);
  /** 0 = tone keyed on the world cell, 1 = keyed on ray bearing. */
  const uToneMode = uniform(toneMode);
  /** 0 = normal, 1 = hit mask, 2 = hit distance, 3 = height up the column. */
  const uDebugMode = uniform(0);
  /**
   * Tallest possible canopy in METRES, i.e. `grassScale * 255`.
   *
   * ONE uniform, used for two jobs that are the same number: it scales the 0-1 canopy
   * field into metres, and it sets how far a ray must travel to cross the volume. It
   * used to be two (`grassScale` and `canopyMax`) holding identical values, kept equal
   * by hand from the debug panel — a duplication with no upside and a silent-drift
   * failure mode.
   */
  const uCanopyMax = uniform(canopyMax);
  const uTone = uniform(toneVariation);
  const uShadeBase = uniform(shadeBase);
  /** LIVE coarse sample count. Cannot exceed the compiled `steps`, which is the cap. */
  const uSteps = uniform(Math.min(stepsRun ?? coarseSteps, coarseSteps));
  /** Debug: 1 replaces the canopy field with full height everywhere. */
  const uCanopyForce = uniform(canopyForce ? 1 : 0);
  const uFadeStart = uniform(fadeStart);
  const uFadeEnd = uniform(fadeEnd);

  // TSL node types are structurally intricate; these graph helpers take nodes
  // loosely. The graph is validated by compiling and running it, not by tsc.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type NodeArg = any;

  // World xz -> tile uv. Maps repeat, so values outside [0,1] are fine.
  const toUv = (xz: NodeArg): NodeArg => xz.add(uHalfWorld).div(uWorldSize);

  const uChunkSize = uniform(chunkSize);
  // Finite switch distances only; the CPU's trailing Infinity catches the rest.
  const lodEdges = lodDistances.filter((d) => Number.isFinite(d));
  // See meshMipAt. 0 for the real map, -1 for the synthetic fallback.
  const mipOffset = Math.round(Math.log2(finestVertexSpacing / texelSize));

  /**
   * Which mip level the terrain MESH is drawing at this world position.
   *
   * Reproduces Terrain.tsx's rule exactly: LOD is chosen per CHUNK, from the
   * horizontal distance between the camera and that chunk's CENTRE, against the same
   * thresholds. Per chunk rather than per sample is the point — using the sample's own
   * radial distance would be cheaper and smoother, but it would disagree with the mesh
   * on both sides of every chunk boundary, which is the exact defect being fixed.
   *
   * `LOD_SEGMENTS` halves per level, so mesh LOD k lands on every 2^k-th grid sample
   * and mip level k IS LOD k. Break that pairing and this mapping fails silently, with
   * grass sinking into hillsides again.
   */
  const meshMipAt = (xz: NodeArg): NodeArg => {
    const chunk = xz.add(uHalfWorld).div(uChunkSize).floor();
    const centre = chunk.add(0.5).mul(uChunkSize).sub(uHalfWorld);
    const d = centre.distance(vec2(cameraPosition.x, cameraPosition.z));
    // Count thresholds passed. `x.step(edge)` is step(edge, x) — one of the argument
    // reorderings catalogued in docs/08 §11.
    let lod: NodeArg = float(0);
    for (const edge of lodEdges) lod = lod.add(d.step(float(edge)));
    // MESH LOD IS NOT ALWAYS MIP LEVEL. Mip k has spacing `texelSize * 2^k`; mesh LOD k
    // has spacing `chunkSize / LOD_SEGMENTS[0] * 2^k`. Those are equal only when the
    // chunk's finest vertex spacing IS one texel — true for the 1024-texel real map
    // (256/128 = 2 m = METERS_PER_TEXEL) and FALSE for the synthetic fallback, where a
    // 512-sample grid over 2048 m gives a 4 m texel against 2 m vertices. Deriving the
    // offset keeps the pairing honest instead of leaving it a coincidence between three
    // constants that fails silently when any of them moves.
    return lod.add(float(mipOffset)).max(float(0));
  };

  // The height texture carries METRES directly (half-float), already reconstructed to
  // remove 8-bit terracing, so there is nothing to scale.
  //
  // SAMPLED AT THE MESH'S OWN LOD, not at full resolution. Reading the full-resolution
  // field made the march write hit depths on a surface the mesh was not drawing: at
  // 16 m vertex spacing the mesh's facets sit of order a metre off it, more than the
  // canopy is tall, so terrain won the depth test and swallowed whole hillsides of
  // grass. Matching the mesh is what makes the two agree; see heightTexture.ts for why
  // this cannot instead be fixed by drawing more vertices.
  //
  // EXPLICIT level, never derivative-selected. The uv comes from a raymarch hit, so
  // neighbouring pixels can land metres apart and implicit derivatives would pick a mip
  // near the top of the pyramid — the same trap that produced the pale-wash artifact.
  //
  // The level is passed in, computed ONCE PER FRAGMENT rather than per sample. Evaluated
  // inside the march it cost 21.9 ms against 10 ms: the march evaluates ground at every
  // one of `steps + refineSteps` samples, so a dozen extra ALU ops there is a dozen times
  // over, and lanes landing on different levels break texture cache coherence too.
  //
  // The approximation that buys it back: a ray uses its ENTRY chunk's level for the whole
  // traversal, so a ray crossing a chunk boundary mid-slab is off by one level on the far
  // side. That is a fraction of the canopy height, against the metre-scale error this
  // whole change exists to remove.
  //
  // HALF-TEXEL SHIFTED, and the shift GROWS WITH THE LEVEL. The two interpolations do
  // not agree on where a sample sits: `Heightfield.sample` — which the mesh is built
  // from — puts grid node i at grid coordinate i, while GPU bilinear puts texel i's
  // centre at i + 0.5. Sampling the raw uv therefore reads the surface displaced
  // horizontally by half a texel of the level in use: 1 m at LOD 0, but 8 m at LOD 3.
  // On a slope that is metres of vertical error, and being a fixed horizontal offset it
  // is DIRECTIONAL — it lands on whichever faces of a hill point along the shift, which
  // is why the bald patches sat on one side of a cliff and moved as the camera turned
  // rather than staying with the terrain.
  const groundAt = (xz: NodeArg, mip: NodeArg): NodeArg => {
    const halfTexel = float(texelSize).mul(mip.exp2()).mul(0.5);
    return texture(heightMap, toUv(xz.add(halfTexel))).level(mip).r;
  };

  /**
   * Smooth canopy envelope: WHERE grass grows and roughly how tall.
   *
   * `uCanopyForce` at 1 replaces the field with full height EVERYWHERE. A debug dial,
   * and a necessary one: on Green Mile the canopy is a colormap-derived stand-in
   * (`grassSource: "colormap-standin"`, docs/06 §7), so it is patchy and much of a
   * frame legitimately has little or no grass. That makes it impossible to tell a
   * shader problem from an absence of canopy — an A/B on strand height variation came
   * out indistinguishable partly for this reason. Forcing full canopy isolates the
   * column renderer from the field feeding it.
   *
   * Never leave this on for a measurement: full canopy everywhere is both the worst
   * case for the march and not what the map says.
   */
  const canopyBase = (xz: NodeArg): NodeArg =>
    uCanopyForce.mix(texture(grassMap, toUv(xz)).r, float(1)).mul(uCanopyMax);

  /**
   * Stable per-column hash, keyed on the grass cell.
   *
   * Cell indices are wrapped into a small range FIRST. A sin-based hash loses
   * all precision at large arguments in float32, and cell indices here are
   * world-metres / cell-width — at 672 m with 12 mm cells that is ~56,000, far
   * past where sin(x * 127.1) still varies meaningfully. Left unwrapped the hash
   * degenerates to a near-constant, so finer columns produced LESS variation
   * rather than more. Wrapping costs nothing and the map tiles anyway.
   */
  const cellHash = (cell: NodeArg, salt: number): NodeArg => {
    const p = hashWrapCells;
    const w = cell.sub(cell.div(p).floor().mul(p)); // -> [0, hashWrapCells)
    return w.x.mul(127.1).add(w.y.mul(311.7)).add(salt).sin().mul(43758.5453).fract();
  };

  /**
   * Smooth value noise over the cell grid.
   *
   * A pure per-cell hash makes neighbouring columns completely uncorrelated,
   * which at a grazing angle reads as television static rather than grass —
   * measurably so: autocorrelation collapses to ~0.3 where the references sit
   * near 0.8. Real grass grows in clumps, and DF2's canopy came from a detail
   * TEXTURE with spatial structure, not white noise. Interpolating the hash over
   * a coarser lattice restores that structure.
   */
  const cellNoise = (cell: NodeArg, scale: number, salt: number): NodeArg => {
    const p = cell.div(scale);
    const i = p.floor();
    const f = p.fract();
    // Quintic smoothstep for C2-continuous interpolation.
    const w = f.mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
    const a = cellHash(i, salt);
    const b = cellHash(i.add(vec2(1, 0)), salt);
    const c = cellHash(i.add(vec2(0, 1)), salt);
    const d = cellHash(i.add(vec2(1, 1)), salt);
    // Bilinear: interpolate along x on both rows, then between rows along y.
    // The RECEIVER of .mix() is the interpolant — see the note at `shade` below.
    return w.y.mix(w.x.mix(a, b), w.x.mix(c, d));
  };

  // The clumped field this used to build — two octaves of cellNoise plus a grain
  // term — is now baked into jitterMap (grassJitter.ts). It cost nine sin() calls,
  // and because the march evaluates the column height at every sample that came to
  // ~87% of the whole grass pass. cellNoise and cellHash survive only for the
  // bearing-keyed tone, which is evaluated once per fragment rather than per sample.

  // --- vertex: lift the shell to the LOCAL canopy top -----------------------
  // Lifting by the global maximum put the shell above the terrain everywhere,
  // including over bare ground. At a ridge it therefore overhung the true
  // silhouette, and fragments in that overhang still found columns to shade —
  // drawing a band of grass FLOATING above the skyline (measured: a full-width
  // band ~4 px thick, 10 px at worst).
  //
  // Lifting by the canopy actually present at each vertex makes the shell hug
  // the grass: it collapses onto the terrain where nothing grows, so there is no
  // overhang to shade and no wasted overdraw either.
  const vtxWorld = modelWorldMatrix.mul(vec4(positionLocal, 1));
  const vtxCanopy = canopyBase(vec2(vtxWorld.x, vtxWorld.z));
  // Small margin: a column's height is canopyBase * jitter, jitter <= 1.
  const positionNode = positionLocal.add(vec3(0, vtxCanopy.mul(CANOPY_MARGIN), 0));

  // --- and the CAP, for when the eye is already inside ----------------------
  // The lifted shell is a CEILING: it marks where a ray ENTERS the volume from
  // outside. Inside the canopy no surface does, because the ray is already in the
  // volume at s = 0 — so something has to give those pixels a fragment or no march
  // runs for them at all.
  //
  // This used to be a second per-chunk surface at ground level (the "floor proxy"),
  // and that was the wrong shape. A pixel could be covered by several chunks' proxies
  // at once and march several times for the same near column, which cost 33.3 ms
  // against 8.5 ms once the entry rule was corrected. The case needs exactly ONE
  // fragment per pixel, so it is one screen-covering cap parented to the camera
  // (Terrain.tsx), drawn only while the eye is inside the canopy.
  //
  // It carries no appearance of its own. Whether a pixel shows grass, shows through a
  // gap, or sees all the way out is decided by the march, exactly as before.
  const capPositionNode = positionLocal;

  // --- fragment: march down through the volume ------------------------------
  // The march is expensive, so it runs ONCE and returns a struct: colour,
  // coverage and hit depth all come from the same traversal. (A TSL function
  // returns a single node, so multiple outputs need a struct rather than
  // separate functions, which would re-march per output.)
  const GrassHit = struct({ rgb: "vec3", hit: "float", depth: "float" }, "GrassHit");

  const makeGrassShade = (isCap: boolean) => Fn(() => {
    const frag = positionWorld;
    const V = frag.sub(cameraPosition).normalize();

    // --- bracket, then bisect -------------------------------------------------
    // Everything is measured as distance from the EYE along V, so there is one
    // parameterisation for both the inside-canopy and outside-canopy cases.
    //
    // The previous scheme took small adaptive steps until it hit something or ran
    // out of budget, with the step derived from the pixel angle. Two problems,
    // both measured (docs/09):
    //
    //   1. Cost was linear in the step budget and the budget had to be generous,
    //      because a ray that misses runs every iteration and one long lane holds
    //      its whole warp. 96 steps cost 72 ms; 16 cost 17 ms.
    //   2. The step scaled with distance from the eye, but the traversal length a
    //      ray NEEDS scales with 1/sin(angle), and those are independent. A near
    //      grazing ray got a small step because it was near and needed tens of
    //      metres because it was shallow, so it ran out and dropped grass.
    //
    // So: size the span by the VIEW ANGLE, which is what actually determines how
    // far the ray must travel, and spend a fixed number of samples on it. A steep
    // ray crosses the canopy in barely more than the canopy's height and gets very
    // fine sampling; a grazing ray gets a long span sampled coarsely.
    // Vertical rate along the ray, floored so a horizontal ray gets a finite span.
    const vy = V.y.abs().max(float(0.02));
    const spanFull = uCanopyMax.add(1.0).div(vy).min(uMaxSpan) as NodeArg;
    // The CAP starts inside the volume, so it does not need the full reach: grass here
    // is struck within a couple of metres. Shortening it also SHARPENS that case, since
    // sample spacing is span/steps. The ceiling keeps the full span — rays that need to
    // reach far grass are exactly the ones entering from above.
    const span = (isCap ? spanFull.min(uInsideSpan) : spanFull).toVar();
    // Divided by the LIVE count, not the compiled one — see uSteps.
    const ds = span.div(uSteps.max(float(1)));

    // --- where the ray enters the slab: ONE rule, PER FRAGMENT ----------------
    // The entry is where this pixel's ray first crosses into the grass slab. That is
    // a property of the ray and the proxy, and of NOTHING ELSE — in particular not of
    // where the camera is standing.
    //
    //   ceiling proxy — the fragment IS the canopy top, so the ray enters there.
    //   cap           — the eye is already inside the volume, so the ray entered at
    //                   s = 0 and the march starts at the near clip.
    //
    // `isCap` is a JS constant baked per material, not a uniform: the two proxies
    // compile separate shaders anyway (see `build`), so this costs nothing at runtime.
    //
    // TWO EARLIER SHAPES, BOTH WRONG, BOTH WORTH NOT REPEATING.
    //
    // 1. `inside ? nearClip : fragDistance`, one choice for the whole frame. `inside`
    //    describes the CAMERA, so with `hitS <= sEnter + span` and `span <= maxSpan`
    //    (48 m) it put a hard arithmetic ceiling on hit distance: the instant the eye
    //    entered the canopy, NO fragment anywhere on screen could resolve a hit beyond
    //    about 49 m, and everything past that was a forced miss showing bare colormap.
    //    Going prone switched off all distant grass at once. That is a fairness bug,
    //    not a cosmetic one — concealment is queried analytically against
    //    grassHeightField (docs/04 §2), so a target prone in distant grass counts as
    //    concealed whatever the screen shows. See docs/08 §8 invariant 6.
    //
    // 2. Searching a near interval and then, on a miss, a far one. It fixed the
    //    ceiling but inlined the whole march TWICE, and it kept the camera in the
    //    entry rule — so the texture of DISTANT grass changed as you went prone, which
    //    it must not: a column 800 m away does not care about your stance.
    //
    // 3. Keying the entry on FRONT/BACK FACING of the ceiling. Correct per pixel, and
    //    it is what proved the diagnosis — prone, the hit-distance view read 120-300 m
    //    across the upper frame because the march was starting where the ray LEFT
    //    through the roof. But a ray inside the canopy passes under many chunks'
    //    ceilings, so every one of those back faces marched the same near column:
    //    33.3 ms against 8.5 ms. The insight survives, the shape does not — one cap
    //    gives that case exactly one fragment, and the ceiling goes back to front faces
    //    only (see `build`, which sets FrontSide).
    const fragDist = frag.distance(cameraPosition) as NodeArg;

    // The near clip is a floor on where the march STARTS, and it may never be allowed
    // to start past the ground the ray is heading for.
    //
    // AN INVARIANT 6 FAMILY MEMBER (docs/08 §8), found the way that section prescribes:
    // the hit mask, prone, with the canopy forced on. A flat 1.2 m clip puts the whole
    // searched interval underground whenever the ray meets the ground nearer than that
    // — the first sample tests below-terrain and breaks, so the fragment misses however
    // much grass is standing there. Prone at 0.35 m AGL that is most of the lower
    // screen: every ray steeper than about 16 degrees crosses the ground inside 1.2 m.
    // It measured as a solid bare band that survived `?canopyall=1` unchanged, while
    // standing at 1.7 m showed none of it. Fairness-inverted, and again reached by
    // going prone.
    //
    // For the CAP the ray starts at the eye, so the crossing is eye height above ground
    // over the ray's vertical rate. Clamp the clip to half of that: half the interval is
    // always left to search, the clip still applies in full at any normal angle, and it
    // degrades smoothly instead of switching the march off. Ascending rays never meet
    // the ground, hence the large sentinel.
    const capEntry = isCap
      ? (() => {
          const eyeXZ = vec2(cameraPosition.x, cameraPosition.z) as NodeArg;
          const eyeAgl = cameraPosition.y.sub(groundAt(eyeXZ, meshMipAt(eyeXZ))).max(float(0));
          const toGround = V.y.lessThan(0).select(eyeAgl.div(vy), float(1e6));
          return uNearClip.min(toGround.mul(0.5)) as NodeArg;
        })()
      : null;

    // --- ENTERING the volume, or EXITING it? --------------------------------
    // `sEnter = fragDist` is right only when the ray comes from OUTSIDE and crosses
    // the canopy top on its way in. Inside the canopy — prone, crouched, or anywhere
    // the eye is under the ceiling — the ray is already in the volume at s = 0, and
    // the ceiling fragment it reaches is where it LEAVES through the roof. Taking that
    // as the entry starts the march at the exit: measured prone on flat ground looking
    // level, the hit-distance view read 120-300 m across the upper frame. The grass
    // being drawn was grass a couple of hundred metres away, and the metre of canopy
    // the player was lying in was stepped straight over. That is why raising the canopy
    // to 1.2 m changed nothing, and why prone and crouch were never blinded.
    //
    // The CAP answers that case instead, with one fragment per pixel, entering at
    // `capEntry` above: the near clip, clamped to the midpoint of the ray's own crossing
    // to the ground. Note what that clamp is keyed on — the EYE's height above ground,
    // not `fragDist`. For the cap `fragDist` is just CAP_DISTANCE, 0.2 m, and says
    // nothing about where the slab ends; the floor proxy this replaced was the one whose
    // `fragDist` measured its own ground point.
    //
    // THE RESIDUAL, accepted knowingly. On a steeply descending ray the clamp wins and
    // the march starts a fraction of a metre out — prone at 0.35 m AGL looking down 45°
    // it starts at 0.25 m. A 0.03 m column subtends about 90 px there, so the canopy
    // draws as large flat slabs. That is precisely the degeneracy `nearClip` exists to
    // prevent, and it is taken deliberately: applying the clip flat instead blanks the
    // near field entirely (§8 invariant 6), and a fairness bug outranks a cosmetic one.
    // The real answer is the docs/03 §4.4 blade layer, not a number here.
    const sEnter = (isCap ? (capEntry as NodeArg) : fragDist) as NodeArg;

    // The per-pixel cede test that used to live here is gone with the floor proxy. It
    // existed because ceiling and floor could both cover a pixel and search different
    // intervals, so they bracketed different columns and the texture of distant grass
    // shifted as you went prone.
    //
    // WHAT REPLACED IT, AND EXACTLY HOW FAR THAT GOES. The ceiling draws front faces
    // only, so while the eye is under the LOCAL canopy the ceiling above it is
    // back-facing, contributes nothing, and the cap owns the pixel outright.
    //
    // That is narrower than "they cannot overlap". Terrain.tsx gates the cap on the
    // map-GLOBAL canopyMax, deliberately — it has the terrain heightfield but not the
    // canopy field, so it cannot know the LOCAL height and errs toward drawing. Wherever
    // local canopy < eye < global max the eye is above the local ceiling: its top face is
    // front-facing, it rasterises, and BOTH proxies march that pixel. On Green Mile that
    // is not an edge case — the canopy is a stand-in with a 0.13 m median against a
    // 1.199 m maximum (docs/06 §7.1), so crouched or prone it is most of the map.
    //
    // Bounded, not free: the cap searches the near interval, so its hit is normally the
    // nearer one and wins the depth test, and the picture stays right. The cost is a
    // second march on those pixels. NOT YET MEASURED — the frame times in docs/09 §0 are
    // both at the vsync cap, which is exactly where a cost like this hides. Measure with
    // `?grasscap=0` crouched on the real canopy (`?canopyall=0`) before assuming it is
    // small, and check the picture too: two intervals bracketing different columns is the
    // artifact the cede test existed to kill.

    // --- which mesh LOD this ray marches against ------------------------------
    // Sampled at BOTH ENDS of the interval the ray will search, and the COARSER of the
    // two is used for the whole traversal.
    //
    // Per sample is exact and costs 21.9 ms against 10 ms — the march evaluates ground
    // at every one of `steps + refineSteps` samples. Per fragment is free but keys the
    // whole ray on the chunk the FRAGMENT sits in, so a grazing ray crossing into a
    // neighbouring chunk drawn at a different level reads the wrong surface on the far
    // side. That showed as bald patches that moved around the sides of cliffs as the
    // camera turned, rather than staying put — the signature of a direction-dependent
    // lookup rather than a fixed geometric hole.
    //
    // Two lookups instead of sixteen, and COARSER rather than finer because the two
    // failure directions are not equally bad. Marching a surface FINER than the mesh
    // lets the mesh sit above it, terrain wins the depth test, and the grass vanishes —
    // a fairness bug (docs/08 §8 invariant 6). Marching one COARSER can put the grass
    // slightly above the drawn terrain, which reads as a small float and is bounded by
    // the difference between adjacent levels. Bias toward the harmless failure.
    const farXZ = cameraPosition.add(V.mul(sEnter.add(span))) as NodeArg;
    const fragMip = meshMipAt(vec2(frag.x, frag.z))
      .max(meshMipAt(vec2(farXZ.x, farXZ.z)))
      .toVar();

    const cellW = uCell;
    const hit = float(0).toVar();
    const hitFrac = float(0).toVar(); // 0 at the column base, 1 at its tip
    const hitXZ = vec2(0, 0).toVar();
    const hitCell = vec2(0, 0).toVar();
    const hitS = float(0).toVar(); // eye distance to the hit, for depth output

    // Coarse pass tests the SAME predicate the refinement will bisect against: the
    // JITTERED per-column top.
    //
    // It used to test the smooth envelope instead, on the reasoning that a 2 m
    // envelope is well sampled at metres of spacing while a 0.03 m column is not.
    // That reasoning is fine and the consequence was fatal: bisection requires the
    // predicate to differ at the two ends of the bracket. Bracketing on the
    // envelope and refining on the jittered top gave a bracket where the fine
    // predicate could be true at BOTH ends, so the bisection collapsed onto the
    // entry point — and the entry point is the shell, which sits at the canopy top
    // by construction. Every hit came out at the very tip of its column, so the
    // grass rendered as a zero-thickness skin floating at canopy height, with
    // holes wherever the predicate was false at both ends instead.
    //
    // Same predicate throughout costs a clump() per coarse step, and it can step
    // over a tall column and bracket a later one. Both are acceptable; a hit at the
    // wrong column still has a correct height, whereas the alternative had every
    // hit at the wrong height.
    // Per-column jitter and tone come from ONE fetch of the baked field. The hash
    // this replaces was nine sin() calls, and the march has to evaluate the column
    // height at every sample, so it dominated everything: 99.8 ms against 12.57 ms
    // for the same sample count with the jitter stubbed to a constant.
    //
    // NEAREST-sampled at the cell centre, so the value stays constant across a
    // column and the columns remain discrete blocks with hard edges.
    // TWO SCALES, and the split is a cache decision as much as a visual one.
    //
    // COARSE, from the texture, mapped across `hashPeriod` METRES. One texel is 0.117 m,
    // so consecutive march samples along a ray — steps of order metres/steps — land in
    // the same texel or its neighbour, and neighbouring screen pixels do too. That
    // locality is why one fetch per sample is affordable at all.
    //
    // Sampling this per CELL instead was tried, to get per-strand height at any column
    // width. It works visually and it HALVES THE FRAME RATE: the march evaluates column
    // height at `steps + refineSteps` samples per fragment, and at 0.002 m columns a
    // single 0.1 m march step spans ~50 texels, so every one of those fetches misses the
    // texture cache instead of hitting it. Do not reintroduce it.
    const jitterAt = (centre: NodeArg): NodeArg =>
      texture(jitterMap, centre.div(uHashPeriod));

    /**
     * FINE, per column, from arithmetic — no memory traffic.
     *
     * This is what makes thin columns worth having: the texture cannot resolve a strand
     * without thrashing, so the per-strand term has to cost ALU rather than bandwidth.
     * A sin-free hash, ~6 operations, against a cache miss that costs hundreds of cycles.
     *
     * NOT the nine-`sin()` fbm this file used to carry — that was 87% of the whole pass
     * (99.8 ms against 12.57 ms). One cheap hash is a different order of thing.
     *
     * Cell indices are wrapped first. They are world-metres/cell-width, so at 0.002 m
     * columns they reach the hundreds of thousands, and `fract()` on values that large
     * has no bits left to vary — the hash would degenerate to a constant and finer
     * columns would again produce LESS variation, which is the exact trap `cellHash`
     * already documents. The wrap repeats every 4096 columns: 8.2 m at 0.002 m. Short,
     * but this term is white noise at strand frequency, where a repeat is far harder to
     * see than in the coarse structure the texture still supplies.
     */
    const strandHash = (cell: NodeArg): NodeArg => {
      // mul by 1/4096 rather than div: same wrap, one cheaper instruction.
      const w = cell.sub(cell.mul(1 / 4096).floor().mul(4096));
      const p = w.mul(vec2(0.1031, 0.1030)).fract().toVar();
      p.addAssign(p.dot(vec2(p.y, p.x).add(33.33)));
      return p.x.add(p.y).mul(p.x).fract();
    };

    const columnTopAt = (P: NodeArg) => {
      const cell = vec2(P.x, P.z).div(cellW).floor();
      const centre = cell.add(0.5).mul(cellW);
      const ground = groundAt(centre, fragMip);
      const j = jitterAt(centre);
      return {
        cell,
        centre,
        ground,
        jitter: j,
        // Coarse clumping from the texture, per-strand raggedness from the hash.
        //
        // THIS is the term that costs, because it is evaluated at every march sample
        // rather than once at the hit. At `uStrandMix = 0` the hash folds away to a
        // constant factor the compiler can hoist, so 0 is genuinely the cheap setting
        // and the slider is a real performance dial — the only one in the panel that is.
        top: ground.add(
          canopyBase(centre).mul(
            uStrandMix.mix(j.r, strandHash(cell)).mul(0.62).add(0.38)
          )
        ),
      };
    };

    // Bracket then bisect over the one interval `[sEnter, sEnter + span]`.
    //
    // ONE instantiation. An earlier version made this a closure and called it twice,
    // near interval then far, which inlined both loops into the shader. Keep it single
    // — the entry rule above makes a second interval unnecessary.
    //
    // Skipped entirely on floor fragments the ceiling owns, so the saving is the whole
    // march and not just the shading. `hit` stays 0 there and the alpha test drops the
    // fragment, leaving the ceiling's answer standing.
    const marchOnce = () => {
      // --- world-anchored sample phase -------------------------------------
      // The coarse samples sit at sEnter + k*ds, and sEnter is the distance from the
      // CAMERA. So every sample plane slides along the ray as the camera moves. A thin
      // column bracketed at sample k one frame is stepped over the next and a different
      // column is hit instead — the resolved hit jumps by up to a full ds, and the grass
      // appears to swim. At 96 coarse steps ds was ~0.5 m and this was invisible; at the
      // designed 12 it is up to 4 m for a grazing ray, which is exactly the
      // walking-toward-a-crest case where it was reported.
      //
      // Anchoring the phase to WORLD HEIGHT fixes it: pin the samples to fixed multiples
      // of the per-step vertical drop, so they stay on the same world planes no matter
      // where the camera stands.
      //
      //   dy = ds * vy                      vertical drop per coarse step
      //   the offset to the next plane is fract(yEnter / dy) * dy in height,
      //   which along the ray is that over vy — so simply fract(yEnter / dy) * ds.
      //
      // This does not make the march finer and is not meant to: it makes it STABLE.
      // Coarse but steady reads as slightly blocky grass; coarse and sliding reads as the
      // whole field crawling, which is far more objectionable.
      //
      // Cost: nil. It was once suspected of a 4x regression and measured innocent —
      // removing it changed nothing, and the real cause was the laptop throttling on a
      // low battery. Confirm the power state before blaming a shader change for a frame
      // time that moved without an edit.
      const dy = ds.mul(vy);
      const yEnter = cameraPosition.y.add(V.y.mul(sEnter));
      // Correct for BOTH directions. Descending, sample heights land on
      // floor(yEnter/dy)*dy - k*dy, exact multiples of dy. Ascending with the same
      // phase they land on (floor + 2*fract)*dy + k*dy, which still slides with the
      // camera — so the anti-swim fix did nothing when looking up, which is the
      // walking-toward-a-crest case it was written for.
      const frac = yEnter.div(dy).fract();
      const phase = V.y.lessThan(0).select(frac, frac.oneMinus()).mul(ds);

      const bracketLo = sEnter.toVar();
      const bracketHi = float(0).toVar();
      const bracketed = float(0).toVar();
      const s = sEnter.add(phase).toVar();

      // The loop is COMPILED at `coarseSteps` but RUNS to `uSteps`, so the sample count
      // is a live slider instead of a rebuild. `Loop()` bakes its count into the graph,
      // and rebuilding the material to change it throws away the terrain geometry cache
      // and stalls for about a second — which makes A/B comparison useless, and the
      // sample count is the single dial that sets frame time (docs/09 §2), so it is the
      // one most worth being able to sweep by hand.
      //
      // Costs one compare per iteration. Lanes already break early on a hit, so the
      // divergence this adds is not new. Set `?steps=` high enough at load to leave
      // headroom above whatever the slider might be pushed to; the slider cannot exceed
      // the compiled count.
      const k = float(0).toVar();

      Loop(coarseSteps, () => {
        If(k.greaterThanEqual(uSteps), () => {
          Break();
        });
        k.addAssign(1);
        const P = cameraPosition.add(V.mul(s));
        const { top } = columnTopAt(P);

        If(P.y.lessThan(top), () => {
          bracketHi.assign(s);
          bracketed.assign(1);
          Break();
        });
        // NO below-terrain early-out here, and do not add one back.
        //
        // `top` is `ground + canopy * m` with m >= 0.38 and canopy >= 0, so top is never
        // below ground: reaching this line means P.y >= top, which already implies
        // P.y >= ground. Any such test is dead.
        //
        // It USED to sit here and it was reordered above the column test on exactly that
        // reasoning. That is a regression, not a fix. The column test firing first is
        // load-bearing: a sample that starts marginally below the reconstructed ground —
        // routine, since mesh and march agree only to within the LOD reconstruction —
        // still brackets the column and resolves a hit. Breaking instead turns it into a
        // miss, and whether it trips flips from one sample plane to the next, which drew
        // concentric rings of missing grass across every hillside.
        bracketLo.assign(s);
        s.addAssign(ds);
      });

      // Refinement: bisect the bracket, now a valid one — the predicate is false at
      // bracketLo and true at bracketHi by the coarse loop's own test.
      //
      // This is what gives the grass thickness. The bisection walks BACK toward the
      // ray's entry, so the hit lands where the ray actually enters the column
      // rather than at the shell, and hitFrac spreads across the column's height
      // instead of pinning to 1.
      If(bracketed.equal(1), () => {
        const lo = bracketLo.toVar();
        const hi = bracketHi.toVar();

        Loop(refineSteps, () => {
          const mid = lo.add(hi).mul(0.5);
          const P = cameraPosition.add(V.mul(mid));
          const { top } = columnTopAt(P);
          // Branchless: keeps every lane on the same instruction path.
          const below = P.y.lessThan(top);
          hi.assign(below.select(mid, hi));
          lo.assign(below.select(lo, mid));
        });

        // Resolve at the first distance known to be inside a column.
        const P = cameraPosition.add(V.mul(hi));
        const { cell, centre, ground, top } = columnTopAt(P);

        hit.assign(1);
        hitFrac.assign(P.y.sub(ground).div(top.sub(ground).max(float(0.001))).clamp(0, 1));
        hitXZ.assign(centre);
        hitCell.assign(cell);
        hitS.assign(hi);
      });
    };

    marchOnce();

    // Colour: ONE value per column, smeared up its whole height — this is what
    // produces vertical striations rather than soft volumetric grass
    // (docs/07 §1.1). The colormap supplies the local ground tone; the
    // per-column hash supplies the horizontal variation between neighbours.
    // EXPLICIT mip level 0. This is not an optimisation, it is the fix for grass
    // rendering as a pale wash.
    //
    // The uv here is derived from the raymarch HIT and quantised to the terrain
    // texel, so two neighbouring pixels can resolve to columns metres apart at
    // very different ranges. Implicit derivatives therefore see an enormous uv
    // gradient and select a mip near the TOP of the pyramid — effectively the
    // average colour of the entire colormap, which for this map is a pale
    // grey-beige. It showed as washed-out grass speckled with correct colour
    // wherever neighbouring pixels happened to land in the same cell, got worse
    // with a taller canopy and at grazing angles, and was unaffected by fog.
    //
    // Level 0 is right rather than merely expedient: the colour is meant to be a
    // NEAREST lookup at the texel the column stands on (docs/07 §1.1), so mip
    // filtering was never wanted. The other in-loop fetches are unaffected because
    // their textures carry no mip chain.
    // Sampled at the struck COLUMN's centre, with the texture's own linear filtering.
    //
    // This used to snap to the TERRAIN TEXEL centre, on the reasoning that DF2 did
    // `map.color[mapoffset]` — a nearest lookup — and painted a whole vertical span in
    // that one colour. The reasoning is right about the original and wrong here, because
    // the two engines' texel and column sizes do not correspond: DF2's colour texel WAS
    // its column, whereas ours is 2 m while a column is 0.03 m. Snapping therefore made
    // ~67 adjacent columns share one colour, and a 2 m block at 10 m subtends roughly
    // 170 px — the hard-edged colour blocks in the near field, over a colormap that is
    // itself perfectly smooth (the terrain material samples it linearly and shows none).
    //
    // Sampling per column keeps what actually matters — ONE colour per column, smeared up
    // its full height, which is what gives vertical striations rather than soft
    // volumetric grass (docs/07 §1.1) — while letting neighbouring columns differ. The
    // horizontal variation DF2 got from its colormap now comes from the per-column tone
    // hash instead, which is where it has to come from at this texel-to-column ratio.
    //
    // EXPLICIT level 0 still. The uv derives from the raymarch hit, so two neighbouring
    // pixels can resolve to columns metres apart at very different ranges; implicit
    // derivatives see an enormous gradient and pick a mip near the top of the pyramid,
    // which is the whole colormap averaged to a pale grey-beige. That was the original
    // pale-grass artifact.
    const base = texture(colorMap, toUv(hitXZ)).level(float(0));

    // Base-to-tip gradient, centred on 1.0 so grass keeps the average brightness of
    // the terrain it stands on. Vertical variation should be SMALLER than horizontal
    // — colour persists up a column and changes across columns, h/v ≈ 1.6 in the
    // references — but it must not be zero, or the columns have no form at all.
    //
    // TSL TRAP — the RECEIVER of `.mix()` is the INTERPOLANT, not the first
    // operand. `t.mix(a, b)` is `mix(a, b, t)`; three registers the method as
    // `mixElement = (t, e1, e2) => mix(e1, e2, t)` (MathNode.js). Written the
    // GLSL way, `a.mix(b, t)` silently compiles to `mix(b, t, a)` — a valid
    // expression with the operands rotated, so there is no error to see, only a
    // wrong picture. All four mixes in this file had it. It is the same class of
    // trap as `smoothstep`, which reorders the same way; `clamp`, `min`, `max`
    // and `step` do NOT, so the rule cannot be applied by habit — check
    // `addMethodChaining` in MathNode.js. Here the intent is
    // mix(base, tip, hitFrac), so hitFrac is the receiver.
    // Radians per pixel. Also decides where a column stops being resolvable.
    const pixelAngle = float(2).div(
      (cameraProjectionMatrix as NodeArg)[1].y.mul(screenSize.y)
    );

    // FADED OUT ONCE A COLUMN IS SUB-PIXEL. This is what removes the hard blocky facets.
    //
    // hitFrac is only as precise as the march resolves. `span` is canopy height over the
    // ray's vertical rate, so a grazing ray gets the full 48 m clamp: ds = 48/12 = 4 m,
    // and four bisections narrow that to 4/16 = 0.25 m. Against a 1.2 m canopy that
    // quantises hitFrac into about five levels, and the 0.78-1.22 ramp turns those five
    // levels into five flat brightness steps. They read as hard-edged polygonal blocks
    // because the quantisation is driven by the ray's vertical rate and its entry point,
    // both of which change across every triangle of the faceted shell — so the banding
    // lands on mesh facets and looks like geometry rather than like error.
    //
    // Beyond `cellSize / pixelAngle` a column is under one pixel wide, so a base-to-tip
    // gradient across it cannot be seen and the term carries nothing but that error.
    // Fading it to neutral over the following octave costs two instructions and leaves
    // the near field — where the ramp is genuinely visible — untouched.
    const subPixel = uCell.div(pixelAngle);
    const rampVisible = (hitS as NodeArg)
      .smoothstep(subPixel, subPixel.mul(4) as NodeArg)
      .oneMinus();
    const shadeNear = hitFrac.clamp(0, 1).mix(uShadeBase, uShadeBase.oneMinus().add(1));
    const shade = rampVisible.mix(float(1), shadeNear);
    // Per-column tone — the "corduroy" carrying the horizontal variation the
    // references show (h/v derivative ratio ~1.6).
    // Per-column tone. Applied around 1.0 but with the downward swing damped:
    // the colormap is pre-shaded, so its ravine shadows are already near-black,
    // and a raw multiply crushed them to true black along the baked shadow
    // lines. Vary brightness without eating the existing shadow detail.
    // Two candidate keys for that horizontal variation, switchable live so the
    // question can be settled by looking rather than by argument (uToneMode).
    //
    // 0 — WORLD CELL. What shipped. Each 0.03 m column gets its own tone. Adjacent
    //     pixels stacked up a screen column cross the surface in DIFFERENT cells,
    //     so the tone is white noise vertically and reads as stipple.
    //
    // 1 — RAY BEARING. DF2's striations were not the sides of tall geometry — the
    //     canopy is barely a metre, so at range it is genuinely a thin skin. They
    //     came from DrawVerticalLine filling a vertical RUN of pixels from one
    //     sample. Bearing is constant along a ray, so a screen column shares one
    //     tone; quantising it to a few pixels of angle holds stripe width constant
    //     at every distance. Colour still comes from the world colormap, so only
    //     the brightness modulation is view-keyed.
    // Tone comes from the baked field's G channel, at the struck column's centre.
    // Tone is evaluated ONCE, at the hit — not per march sample — so the per-cell hash
    // costs nothing measurable here and is applied unconditionally at a fixed ratio.
    //
    // This is the important half of the look and the free half. The "corduroy" of
    // docs/07 §1.4 is adjacent columns differing in BRIGHTNESS, and that is what makes
    // thin columns read as thin at any width. Height raggedness (§1.3) shows only on the
    // silhouette, and it is the expensive half — see uStrandMix below.
    const cellSwing = float(0.5).mix(jitterAt(hitXZ).g, strandHash(hitCell));

    const stripe = (V.x.atan(V.z) as NodeArg).div(pixelAngle.mul(uStripePixels)).floor();
    const stripeKey = vec2(stripe, 0);
    // Grouped in threes plus per-stripe grain, so stripes read as tufts not a comb.
    const bearingSwing = cellNoise(stripeKey, 3, 17.3)
      .mul(0.62)
      .add(cellHash(stripeKey, 29.1).mul(0.38));

    const swingRaw = uToneMode.lessThan(0.5).select(cellSwing, bearingSwing);
    // Applied around 1.0 with the downward swing damped: the colormap is
    // pre-shaded, so its ravine shadows are already near-black and a raw multiply
    // crushed them to true black along the baked shadow lines.
    const swing = swingRaw.sub(0.5).mul(uTone);
    const tone = swing.max(swing.mul(0.35)).add(1.0);

    // Fade columns into the colormap with distance; the colormap is already
    // grass-coloured at 100% coverage, so the handover is invisible.
    //
    // The fade distances scale with ZOOM for the same reason the march step
    // does: the handover is only invisible while columns are sub-pixel. Through
    // a scope they are not, so a fixed fade would dissolve grass into flat
    // colour exactly where a sniper is looking — and ~800 m is where the
    // concealment mechanic is defined, so the picture and the gameplay query
    // would disagree at the one range that matters.
    const p11: NodeArg = (cameraProjectionMatrix as NodeArg)[1].y;
    const zoom = p11.div(float(referenceP11)).max(float(1));
    // Edges ascending, then inverted. three maps `x.smoothstep(a, b)` onto
    // `smoothstep(a, b, x)`, so passing (fadeEnd, fadeStart) put the edges in
    // descending order — which both the GLSL ES and WGSL specs leave
    // indeterminate. It happens to give the intended ramp on drivers that use the
    // naive formula and may clamp to a constant on drivers that assume e0 < e1.
    // Keyed on the distance to the HIT, not to the shell fragment. The shell is a
    // rasterisation proxy that can sit hundreds of metres from where the ray
    // actually struck — standing inside the canopy it always does — so fading on
    // shell distance dissolved grass a couple of metres away into flat colormap as
    // if it were at 800 m. Every distance-dependent term here has to use the hit.
    const fade: NodeArg = (hitS as NodeArg)
      .smoothstep(uFadeStart.mul(zoom) as NodeArg, uFadeEnd.mul(zoom) as NodeArg)
      .oneMinus();

    // Depth at the RAYMARCH HIT, not at the shell. The shell is the terrain
    // lifted by the tallest canopy, so its rasterised depth is up to a
    // canopy-height too near. Left uncorrected, anything standing IN the grass —
    // a soldier, a vehicle — depth-tests against a surface floating above the
    // grass and pops in front of it, which breaks the one thing this system
    // exists for. (This is the integration hurdle for GPU Voxel Space ports:
    // mixing polygonal objects, not raw speed.)
    // On a MISS, fall back to the shell fragment's own distance rather than leaving
    // hitS at 0, which puts the point at the camera and writes near-plane depth.
    //
    // In normal rendering that never mattered — a miss is alpha-tested away, so its
    // depth is discarded. In the DEBUG views it mattered a great deal and was actively
    // misleading: views >= 4 force opacity to 1 precisely so every shell fragment
    // reports its answer, and those fragments were then drawing at the near plane, in
    // front of everything including sky. A distant miss painted itself over the whole
    // upper frame, so "the shell covers this pixel" and "some far fragment missed" were
    // indistinguishable — which is exactly the question those views exist to answer.
    // The CAP cannot use its own fragDist as the miss fallback: it sits 0.2 m in front
    // of the camera, so that is the near plane — the very defect this line fixes for the
    // shell. Debug views force opacity to 1, and the cap covers the whole screen while
    // the eye is in the canopy, so every missed fragment would paint the frame at the
    // near plane exactly when the inside-canopy case is what you are inspecting.
    const missS = (isCap ? cameraFar : fragDist) as NodeArg;
    const depthS = hit.equal(1).select(hitS.max(float(0)), missS) as NodeArg;
    const hitWorld = cameraPosition.add(V.mul(depthS));
    const viewZ = cameraViewMatrix.mul(vec4(hitWorld, 1)).z;
    const hitDepth = viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar);

    // Distance debug: red near -> green mid -> blue far, banded every 100 m so
    // it is obvious whether a suspect region is hitting nearby grass or grass
    // hundreds of metres away seen over a ridge.
    const dNorm = hitS.div(float(600)).clamp(0, 1);

    // The handover to the colormap is a COLOUR blend, not an opacity ramp.
    // opacityNode feeds an alpha TEST at 0.5 with blending off, so a binary `hit`
    // multiplied by `fade` collapsed the entire 700->1100 m cross-fade into a hard
    // ring at the midpoint, where grass switched off inside one pixel. Blending
    // the column tone toward the plain colormap makes the handover invisible,
    // which is what this fade always claimed to do — and it keeps opacity binary,
    // which is the only thing an alpha test can express.
    const columns: NodeArg = base.rgb.mul(shade).mul(tone);
    // Interpolant first: 0 near, so near grass is pure columns; 1 far, so far
    // grass is the plain colormap.
    const faded: NodeArg = fade.oneMinus().mix(columns, base.rgb);

    // Fog, applied here from the HIT's view depth. three's automatic fog is
    // switched off on this material (see material.fog below) because it uses the
    // rasterised shell depth. Matches three's linear fog exactly —
    // smoothstep(near, far, viewZ) then mix toward the fog colour — so grass and
    // terrain agree at the same distance instead of showing a seam.
    const fogFactor: NodeArg = viewZ.negate().smoothstep(uFogNear, uFogFar);
    // THIS was the pale wash. Written as `faded.mix(uFogColor, fogFactor)` it
    // compiled to mix(uFogColor, fogFactor, faded) — the fog colour became the
    // BASE of the blend and the grass colour became the interpolant, so every
    // fragment came out near the fog colour no matter how near it was. It also
    // explains why pushing the fog range to 1e6 changed nothing: that only drives
    // fogFactor, which in the rotated form is the far end of the blend, weighted
    // by `faded` — a dark grass colour — so it barely contributes.
    const shaded: NodeArg = fogFactor.mix(faded, uFogColor);

    // Debug views are selected by a uniform rather than baked in, so they can be
    // switched without rebuilding the material — which would also throw away the
    // terrain geometry cache.
    //
    // Modes 4-7 bisect the colour expression itself. The pale-wash artifact was
    // chased through four wrong hypotheses by patching first; the only thing that
    // narrowed it was replacing the colour with less of itself and looking. Doing
    // that from a uniform instead of from an edit makes it one build rather than
    // one per term, and 6/7 read out the suspect quantity directly instead of
    // inferring it from what the picture looks like.
    const dbgHit: NodeArg = vec3(1, 0, 1).mul(hitFrac.clamp(0.25, 1));
    const dbgDist: NodeArg = vec3(
      dNorm.oneMinus(),
      dNorm.mul(2).min(dNorm.mul(2).oneMinus().add(1)).clamp(0, 1),
      dNorm
    );
    const dbgFrac: NodeArg = vec3(hitFrac.clamp(0, 1));

    /**
     * Quantise a 0-1 scalar to five flat primaries.
     *
     * Greyscale readouts are not legible through a JPEG screenshot: a mid grey and
     * a dark grey were mistaken for each other, and two views that must agree
     * appeared to contradict. Flat primaries survive compression, so a value can be
     * READ rather than guessed at.
     *
     *   black < 0.125 | blue < 0.375 | green < 0.625 | yellow < 0.875 | red
     */
    const band = (v: NodeArg): NodeArg => {
      const t = v.clamp(0, 1);
      return t
        .lessThan(0.125)
        .select(
          vec3(0, 0, 0),
          t
            .lessThan(0.375)
            .select(
              vec3(0, 0, 1),
              t
                .lessThan(0.625)
                .select(vec3(0, 1, 0), t.lessThan(0.875).select(vec3(1, 1, 0), vec3(1, 0, 0)))
            )
        );
    };

    //   0 normal            5 faded    (columns crossfaded to the colormap)
    //   1 hit mask          6 fog factor, banded
    //   2 hit distance      7 fog input: -viewZ / fogFar, banded
    //   3 height in column  8 fade: grass presence, 1 near to 0 far, banded
    //   4 columns           9 the fog colour uniform, flat
    const views: NodeArg[] = [
      shaded,
      dbgHit,
      dbgDist,
      dbgFrac,
      columns,
      faded,
      band(fogFactor),
      band(viewZ.negate().div(uFogFar)),
      band(fade),
      uFogColor,
    ];
    let rgb: NodeArg = views[views.length - 1];
    for (let i = views.length - 2; i >= 0; i--) {
      rgb = uDebugMode.lessThan(i + 0.5).select(views[i], rgb);
    }

    // Debug views force the shell OPAQUE. Otherwise a miss is alpha-tested away and
    // the terrain colormap shows through the gaps, which in a false-colour readout
    // is indistinguishable from a real value — the terrain's greens and tans read as
    // bands. Opaque means every pixel of the shell reports the shader's own answer.
    const opacity = uDebugMode.greaterThan(3.5).select(float(1), hit);

    return GrassHit(rgb, opacity, hitDepth);
  });

  // ONE march graph, two proxy surfaces. The Fn is instantiated per material —
  // the ceiling and the cap compile separate shaders — but they share every
  // uniform node, so the debug sliders drive both without extra plumbing.
  const build = (position: NodeArg, isCap: boolean): THREE.MeshBasicNodeMaterial => {
    const shaded = makeGrassShade(isCap)();

    // UNLIT. The colormap is pre-shaded — it already bakes lighting and shadow
    // (docs/06 §6) — and the original renderer applied no lighting at all, it just
    // painted map.color. Running PBR on top double-shades it, and at shell
    // silhouettes the interpolated normal goes edge-on and diffuse collapses to
    // zero, leaving black rim artifacts along the canopy edges.
    const m = new THREE.MeshBasicNodeMaterial();
    m.positionNode = position;
    // struct field accessors are loosely typed; the graph is validated by running it.
    m.colorNode = shaded.get('rgb') as NodeArg;
    // Alpha-tested rather than blended: grass is opaque where it exists, and this
    // keeps it in the opaque queue with correct depth against the terrain.
    m.opacityNode = shaded.get('hit') as NodeArg;
    // Correct depth so polygonal objects intersect the grass properly. This does
    // disable early-Z for the grass pass — a real cost, accepted because without
    // it nothing can stand in the grass convincingly.
    //
    // It is also what makes the two passes agree: both march from the eye and write
    // the hit's depth, not the proxy's, so wherever they cover the same pixel they
    // resolve to the same surface at the same depth rather than z-fighting.
    m.depthNode = shaded.get('depth') as NodeArg;
    m.transparent = false;
    m.alphaTest = 0.5;
    // Fog is applied inside colorNode from the raymarch hit's view depth. three's
    // automatic fog would use the rasterised shell depth, which is the wrong
    // distance by up to the whole draw range.
    m.fog = false;
    // FRONT FACES ONLY on the ceiling. It used to be double-sided so that standing
    // inside the canopy you still got a fragment from underneath — but that fragment
    // is where the ray LEAVES the volume, not where it enters, and a ray inside the
    // canopy passes under many chunks' ceilings, so a single pixel marched several
    // times for the same near column. Measured 33.3 ms against 8.5 ms. The cap answers
    // that case with one fragment per pixel, so the undersides are pure waste.
    //
    // The cap stays double-sided: it is parented to the camera and which way it faces
    // is not worth reasoning about.
    m.side = isCap ? THREE.DoubleSide : THREE.FrontSide;
    return m;
  };

  const material = build(positionNode, false);
  const capMaterial = build(capPositionNode, true);

  return {
    material,
    capMaterial,
    uniforms: {
      canopyMax: uCanopyMax,
      cell: uCell,
      tone: uTone,
      shadeBase: uShadeBase,
      steps: uSteps,
      strandMix: uStrandMix,
      canopyForce: uCanopyForce,
      toneMode: uToneMode,
      stripePixels: uStripePixels,
      nearClip: uNearClip,
      maxSpan: uMaxSpan,
      fadeStart: uFadeStart,
      fadeEnd: uFadeEnd,
      debugMode: uDebugMode,
    },
  };
}
