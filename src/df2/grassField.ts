// The canopy field as one set of TSL samplers, shared by every layer that draws it.
//
// The relief march and the near-field blade layer are two representations of ONE
// field, and docs/03 §4.4 names their disagreement as the single hard constraint on
// the blade work — a prior session was lost to two surfaces differing by half a texel.
// So the formulas live here once and both layers call them, rather than each holding
// a copy that agrees today.

import {
  float,
  vec2,
  uniform,
  texture,
  cameraPosition,
} from "three/tsl";
import type * as THREE from "three/webgpu";

export interface GrassFieldOptions {
  /** Per-texel canopy height, 0-255. LINEAR-filtered — this is the envelope. */
  grassMap: THREE.Texture;
  /** Baked per-column jitter (R) and tone (G), tiling over `hashPeriod` metres. */
  jitterMap: THREE.Texture;
  /** Terrain elevation, mip chain decimated to the terrain MESH's LOD lattice. */
  heightMap: THREE.Texture;
  /** Chunk width in metres — the unit LOD switch distances are expressed in. */
  chunkSize: number;
  /** Metres between adjacent MESH vertices at LOD 0 (`chunkSize / LOD_SEGMENTS[0]`). */
  finestVertexSpacing: number;
  /** Metres between adjacent heightfield samples (`Heightfield.cellSize`). */
  texelSize: number;
  /** LOD switch distances in METRES, in the order Terrain.tsx applies them. */
  lodDistances: number[];
  /** Metres spanned by one tile of the maps. */
  worldSize: number;
  /** Metres per raw canopy unit — how tall "255" grass stands. */
  grassScale: number;
  /** Width of one grass column in metres. */
  cellSize: number;
  /** Metres after which the per-column hash pattern repeats. */
  hashPeriod: number;
  /** Share of column height taken from the ALU hash rather than the jitter texture. */
  strandMix: number;
  /** Debug: grow full-height grass everywhere, ignoring the canopy field. */
  canopyForce: boolean;
}

// TSL node types are structurally intricate; these graph helpers take nodes
// loosely. The graph is validated by compiling and running it, not by tsc.
/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

export interface GrassField {
  // The uniforms are typed as loosely as the graph helpers, and for the same reason:
  // `uniform()`'s declared return type carries none of the arithmetic methods the
  // graph is built from. Correctness here is established by compiling the shader.
  /** Tallest possible canopy, metres — `grassScale * 255`. Live on a uniform. */
  canopyMax: NodeArg;
  /** 1 replaces the canopy field with full height everywhere. */
  canopyForce: NodeArg;
  /** Per-strand detail from the ALU hash vs the metre-mapped texture, 0-1. */
  strandMix: NodeArg;
  /** Width of one grass column in metres. */
  cell: NodeArg;
  toUv: (xz: NodeArg) => NodeArg;
  meshMipAt: (xz: NodeArg) => NodeArg;
  groundAt: (xz: NodeArg, mip: NodeArg) => NodeArg;
  /** Raw canopy sample, 0-1. The existence probability, and what canopyBase scales. */
  canopyNorm: (xz: NodeArg) => NodeArg;
  canopyBase: (xz: NodeArg) => NodeArg;
  cellHash: (cell: NodeArg, salt: number) => NodeArg;
  cellNoise: (cell: NodeArg, scale: number, salt: number) => NodeArg;
  jitterAt: (centre: NodeArg) => NodeArg;
  strandHash: (cell: NodeArg, salt?: number) => NodeArg;
  columnTop: (xz: NodeArg, mip: NodeArg) => {
    cell: NodeArg;
    centre: NodeArg;
    ground: NodeArg;
    jitter: NodeArg;
    /** Raw canopy at the column, 0-1. Returned because `top` samples it anyway. */
    canopy: NodeArg;
    /** The per-strand hash at this cell, likewise already evaluated for `top`. */
    strand: NodeArg;
    top: NodeArg;
  };
}

export function createGrassField(opts: GrassFieldOptions): GrassField {
  const {
    grassMap,
    jitterMap,
    heightMap,
    chunkSize,
    finestVertexSpacing,
    texelSize,
    lodDistances,
    worldSize,
    grassScale,
    cellSize,
    hashPeriod,
    strandMix,
    canopyForce,
  } = opts;

  // Cell indices are wrapped to this many cells before hashing. Derived from the
  // requested metric period so the repeat distance does not move with cellSize.
  const hashWrapCells = Math.max(64, Math.round(hashPeriod / cellSize));

  const uWorldSize = uniform(worldSize);
  const uHalfWorld = uniform(worldSize / 2);
  const uChunkSize = uniform(chunkSize);
  const uCell = uniform(cellSize);
  const uHashPeriod = uniform(hashPeriod);
  /** Per-strand HEIGHT from the hash vs the texture. The one dial that costs. */
  const uStrandMix = uniform(strandMix);
  /**
   * Tallest possible canopy in METRES, i.e. `grassScale * 255`.
   *
   * ONE uniform, used for two jobs that are the same number: it scales the 0-1 canopy
   * field into metres, and it sets how far a ray must travel to cross the volume. It
   * used to be two (`grassScale` and `canopyMax`) holding identical values, kept equal
   * by hand from the debug panel — a duplication with no upside and a silent-drift
   * failure mode.
   */
  const uCanopyMax = uniform(255 * grassScale);
  /** Debug: 1 replaces the canopy field with full height everywhere. */
  const uCanopyForce = uniform(canopyForce ? 1 : 0);

  // World xz -> tile uv. Maps repeat, so values outside [0,1] are fine.
  const toUv = (xz: NodeArg): NodeArg => xz.add(uHalfWorld).div(uWorldSize);

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
  // The blade layer needs the explicit level for a second reason: it samples this in
  // the VERTEX stage, where there are no derivatives to select a level with at all.
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
  // rather than staying with the terrain. EVERY new consumer of this texture needs it
  // (docs/08 §11), which is the main reason this function is shared rather than copied.
  const groundAt = (xz: NodeArg, mip: NodeArg): NodeArg => {
    const halfTexel = float(texelSize).mul(mip.exp2()).mul(0.5);
    return texture(heightMap, toUv(xz.add(halfTexel))).level(mip).r;
  };

  /**
   * Smooth canopy envelope: WHERE grass grows and roughly how tall.
   *
   * `canopyForce` at 1 replaces the field with full height EVERYWHERE. A debug dial,
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
  const canopyNorm = (xz: NodeArg): NodeArg =>
    uCanopyForce.mix(texture(grassMap, toUv(xz)).r, float(1));
  const canopyBase = (xz: NodeArg): NodeArg => canopyNorm(xz).mul(uCanopyMax);

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
  const jitterAt = (centre: NodeArg): NodeArg => texture(jitterMap, centre.div(uHashPeriod));

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
   *
   * `salt` offsets the input so one hash can serve several independent per-cell values.
   * That is why the blade layer calls this rather than carrying its own copy: the wrap
   * period and the three multipliers are a live tuning decision documented here, and a
   * second copy would keep the old ones silently after any retune.
   */
  const strandHash = (cell: NodeArg, salt = 0): NodeArg => {
    const c = salt === 0 ? cell : cell.add(vec2(salt * 37.13, salt * 91.71));
    // mul by 1/4096 rather than div: same wrap, one cheaper instruction.
    const w = c.sub(c.mul(1 / 4096).floor().mul(4096));
    // WRITTEN WITHOUT A MUTABLE VAR, deliberately. `toVar()` and `addAssign()` need an
    // enclosing `Fn()` to own the assignment, and this is called from two places with
    // different scopes: the march builds it inside one, the blade layer at graph level.
    // Outside a Fn, TSL logs "No stack defined for assign operation" on every load — the
    // graph still works, but a permanent error is a place a real one can hide. The
    // expression below is the same arithmetic: `p.addAssign(x)` is `p = p + x`, and the
    // dot product reads the pre-assignment value in either form.
    const p0 = w.mul(vec2(0.1031, 0.103)).fract();
    const p = p0.add(p0.dot(vec2(p0.y, p0.x).add(33.33)));
    return p.x.add(p.y).mul(p.x).fract();
  };

  /**
   * The top of the grass column standing at a world position — THE height formula.
   *
   * The march intersects this; the blade layer stands a blade exactly this tall. Two
   * layers, one expression, which is the whole reason this module exists.
   */
  const columnTop = (xz: NodeArg, mip: NodeArg) => {
    const cell = xz.div(uCell).floor();
    const centre = cell.add(0.5).mul(uCell);
    const ground = groundAt(centre, mip);
    const j = jitterAt(centre);
    // Both of these feed `top` below, and the blade layer wants them too. Returning
    // them costs nothing and saves a second grassMap fetch and a second hash per blade
    // vertex — the graph caches by node identity, so recomputing would emit both twice.
    const canopy = canopyNorm(centre);
    const strand = strandHash(cell);
    return {
      cell,
      centre,
      ground,
      jitter: j,
      canopy,
      strand,
      // Coarse clumping from the texture, per-strand raggedness from the hash.
      //
      // THIS is the term that costs, because the march evaluates it at every sample
      // rather than once at the hit. At `strandMix = 0` the hash folds away to a
      // constant factor the compiler can hoist, so 0 is genuinely the cheap setting
      // and the slider is a real performance dial — the only one in the panel that is.
      top: ground.add(
        canopy.mul(uCanopyMax).mul(uStrandMix.mix(j.r, strand).mul(0.62).add(0.38))
      ),
    };
  };

  return {
    canopyMax: uCanopyMax,
    canopyForce: uCanopyForce,
    strandMix: uStrandMix,
    cell: uCell,
    toUv,
    meshMipAt,
    groundAt,
    canopyNorm,
    canopyBase,
    cellHash,
    cellNoise,
    jitterAt,
    strandHash,
    columnTop,
  };
}
