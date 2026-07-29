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

export interface GrassMaterialOptions {
  /** Per-texel canopy height, 0-255. LINEAR-filtered — this is the envelope. */
  grassMap: THREE.Texture;
  /** Terrain elevation, same grid as the canopy field. */
  heightMap: THREE.Texture;
  /** Colormap — the source of each column's colour. */
  colorMap: THREE.Texture;
  /** Metres spanned by one tile of the maps. */
  worldSize: number;
  /** Samples per side of the maps (1024 for DF terrain). */
  mapSize: number;
  /** Metres per raw elevation unit. */
  heightScale: number;
  /** Metres per raw canopy unit — how tall "255" grass stands. */
  grassScale: number;
  /**
   * Coarse bracket samples per fragment. Cost is very close to linear in this
   * (docs/09), so it is the single dial that sets frame time.
   */
  steps?: number;
  /** Bisections inside the bracket. Each one halves the residual error. */
  refineSteps?: number;
  /**
   * Longest span a ray will search, metres. The span is normally set by the view
   * angle — canopy height over the ray's vertical rate — which is what determines
   * how far a ray must travel to cross the canopy. A near-horizontal ray would
   * want an unbounded span, so it is clamped here and gives up beyond it.
   */
  maxSpan?: number;
  /** Width of one tone stripe in pixels, when toneMode is 1. */
  stripePixels?: number;
  /** 0 = tone keyed on the world cell (shipped), 1 = keyed on ray bearing. */
  toneMode?: number;
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
   * Metres ahead of the eye at which the march begins when standing INSIDE the
   * canopy.
   *
   * Prone in grass you should see only grass — that symmetry (concealed means
   * blind) is the mechanic, not a bug. But the fill has to read as grass, and
   * starting at the eye makes every ray hit the same column: at 2 cm range
   * adjacent pixels diverge by ~0.1 mm, so no column width can separate them and
   * the screen resolves to one flat colour. Beginning the march a little way out
   * puts hits where columns actually subtend a few pixels.
   */
  nearClip?: number;
  /** Debug: encode the ray distance of each grass hit as colour (red=near, blue=far). */
  debugDistance?: boolean;
  /** Debug: paint every grass hit flat magenta to inspect the hit mask. */
  debugHit?: boolean;
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
  /** Metres per raw canopy unit, i.e. how tall a 255 canopy stands. */
  grassScale: ReturnType<typeof uniform>;
  /** Tallest possible canopy, metres. Keep in step with grassScale. */
  canopyMax: ReturnType<typeof uniform>;
  cell: ReturnType<typeof uniform>;
  tone: ReturnType<typeof uniform>;
  toneMode: ReturnType<typeof uniform>;
  stripePixels: ReturnType<typeof uniform>;
  nearClip: ReturnType<typeof uniform>;
  maxSpan: ReturnType<typeof uniform>;
  fadeStart: ReturnType<typeof uniform>;
  fadeEnd: ReturnType<typeof uniform>;
  debugMode: ReturnType<typeof uniform>;
}

export interface GrassMaterial {
  material: THREE.MeshBasicNodeMaterial;
  /** Metres the shell is lifted above the terrain — also the tallest canopy. */
  canopyMax: number;
  uniforms: GrassUniforms;
}

export function createGrassMaterial(opts: GrassMaterialOptions): GrassMaterial {
  const {
    grassMap,
    heightMap,
    colorMap,
    worldSize,
    mapSize,
    heightScale,
    grassScale,
    steps: coarseSteps = 12,
    refineSteps = 4,
    maxSpan = 48,
    stripePixels = 3,
    toneMode = 0,
    cellSize = 0.35,
    nearClip = 1.2,
    debugHit = false,
    debugDistance = false,
    toneVariation = 0.42,
    fadeStart = 420,
    fadeEnd = 700,
    hashPeriod = 120,
    // 1/tan(30 deg): a 60-degree vertical FOV, matching config.CAMERA_FOV.
    referenceP11 = 1 / Math.tan((60 * Math.PI) / 180 / 2),
  } = opts;

  // Cell indices are wrapped to this many cells before hashing. Derived from the
  // requested metric period so the repeat distance does not move with cellSize.
  const hashWrapCells = Math.max(64, Math.round(hashPeriod / cellSize));

  const canopyMax = 255 * grassScale;

  const uWorldSize = uniform(worldSize);
  const uHalfWorld = uniform(worldSize / 2);
  const uTexel = uniform(worldSize / mapSize); // metres per map texel
  const uCell = uniform(cellSize); // metres per grass column
  const uNearClip = uniform(nearClip);
  const uMaxSpan = uniform(maxSpan);
  const uStripePixels = uniform(stripePixels);
  /** 0 = tone keyed on the world cell, 1 = keyed on ray bearing. */
  const uToneMode = uniform(toneMode);
  /** 0 = normal, 1 = hit mask, 2 = hit distance, 3 = height up the column. */
  const uDebugMode = uniform(debugHit ? 1 : debugDistance ? 2 : 0);
  const uHeightScale = uniform(heightScale * 255);
  const uGrassScale = uniform(grassScale * 255);
  // Tallest possible canopy: sets how far a ray must travel to cross the volume.
  const uCanopyMax = uniform(canopyMax);
  const uTone = uniform(toneVariation);
  const uFadeStart = uniform(fadeStart);
  const uFadeEnd = uniform(fadeEnd);

  // TSL node types are structurally intricate; these graph helpers take nodes
  // loosely. The graph is validated by compiling and running it, not by tsc.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type NodeArg = any;

  // World xz -> tile uv. Maps repeat, so values outside [0,1] are fine.
  const toUv = (xz: NodeArg): NodeArg => xz.add(uHalfWorld).div(uWorldSize);

  /**
   * Snap a world xz to its TERRAIN TEXEL centre.
   *
   * s-macke/VoxelSpace shows the original took colour as
   * `map.color[mapoffset]` — a NEAREST lookup at texel granularity — and then
   * DrawVerticalLine painted the whole vertical span in that ONE colour. So the
   * horizontal variation between columns comes from the colormap itself, and
   * the vertical coherence comes from a texel's colour covering a tall run of
   * pixels. Sampling the colormap smoothly (and synthesising variation with
   * noise instead) gets both wrong. Sampling at the texel centre reproduces the
   * nearest-neighbour lookup without needing a second texture.
   */
  const texelCentre = (xz: NodeArg): NodeArg =>
    xz.div(uTexel).floor().add(0.5).mul(uTexel);

  const groundAt = (xz: NodeArg): NodeArg =>
    texture(heightMap, toUv(xz)).r.mul(uHeightScale);

  /** Smooth canopy envelope: WHERE grass grows and roughly how tall. */
  const canopyBase = (xz: NodeArg): NodeArg =>
    texture(grassMap, toUv(xz)).r.mul(uGrassScale);

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
    return a.mix(b, w.x).mix(c.mix(d, w.x), w.y);
  };

  /** Clumped field: broad tufts, medium variation, a little per-column grain. */
  const clump = (cell: NodeArg, salt: number): NodeArg =>
    cellNoise(cell, 14, salt)
      .mul(0.55)
      .add(cellNoise(cell, 5, salt + 3.1).mul(0.3))
      .add(cellHash(cell, salt + 7.7).mul(0.15));

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
  const positionNode = positionLocal.add(vec3(0, vtxCanopy.mul(1.04), 0));

  // --- fragment: march down through the volume ------------------------------
  // The march is expensive, so it runs ONCE and returns a struct: colour,
  // coverage and hit depth all come from the same traversal. (A TSL function
  // returns a single node, so multiple outputs need a struct rather than
  // separate functions, which would re-march per output.)
  const GrassHit = struct({ rgb: "vec3", hit: "float", depth: "float" }, "GrassHit");

  const grassShade = Fn(() => {
    const frag = positionWorld;
    const V = frag.sub(cameraPosition).normalize();

    // When the camera stands INSIDE the canopy — which is the whole point of
    // this system — the shell is above the eye and we're looking at its
    // underside, so the ray must start at the camera, not at the rasterised
    // fragment. Otherwise the near field renders no grass at all.
    const camXZ = vec2(cameraPosition.x, cameraPosition.z);
    // Tested against the LOCAL canopy, not the global maximum. Against uCanopyMax
    // this was true whenever the eye sat below the tallest canopy anywhere on the
    // map — including lying on bare ground where nothing grows. Every fragment
    // then marched from the eye at the finest step, so grass past the step budget
    // was unreachable and vanished. The eye is only inside the volume when there
    // is canopy where it actually stands. Uses the same 1.04 margin as the shell.
    const camCanopy = canopyBase(camXZ).mul(1.04);
    const inside: NodeArg = cameraPosition.y.lessThan(groundAt(camXZ).add(camCanopy));

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
    const sEnter = inside
      .select(uNearClip, frag.distance(cameraPosition) as NodeArg)
      .toVar();

    // Vertical rate along the ray, floored so a horizontal ray gets a finite span.
    const vy = V.y.abs().max(float(0.02));
    const span = uCanopyMax.add(1.0).div(vy).min(uMaxSpan).toVar();
    const ds = span.div(float(coarseSteps));

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
    const columnTopAt = (P: NodeArg) => {
      const cell = vec2(P.x, P.z).div(cellW).floor();
      const centre = cell.add(0.5).mul(cellW);
      const ground = groundAt(centre);
      return {
        cell,
        centre,
        ground,
        top: ground.add(canopyBase(centre).mul(clump(cell, 0).mul(0.62).add(0.38))),
      };
    };

    const bracketLo = sEnter.toVar();
    const bracketHi = float(0).toVar();
    const bracketed = float(0).toVar();
    const s = sEnter.add(ds).toVar();

    Loop(coarseSteps, () => {
      const P = cameraPosition.add(V.mul(s));
      const { ground, top } = columnTopAt(P);

      If(P.y.lessThan(top), () => {
        bracketHi.assign(s);
        bracketed.assign(1);
        Break();
      });
      // Below the terrain surface: nothing ahead can occlude.
      If(P.y.lessThan(ground), () => {
        Break();
      });
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

    // Colour: ONE value per column, smeared up its whole height — this is what
    // produces vertical striations rather than soft volumetric grass
    // (docs/07 §1.1). The colormap supplies the local ground tone; the
    // per-column hash supplies the horizontal variation between neighbours.
    const base = texture(colorMap, toUv(texelCentre(hitXZ)));

    // Only a slight base-to-tip gradient. Measured against the references, real
    // columns are near flat-shaded: colour persists UP a column while changing
    // sharply ACROSS columns. A strong vertical ramp destroys that coherence.
    const shade = float(0.88).mix(float(1.05), hitFrac.clamp(0, 1));
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
    const cellSwing = clump(hitCell, 17.3);

    const pixelAngle = float(2).div(
      (cameraProjectionMatrix as NodeArg)[1].y.mul(screenSize.y)
    );
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
    const fade: NodeArg = (frag.distance(cameraPosition) as NodeArg)
      .smoothstep(uFadeStart.mul(zoom) as NodeArg, uFadeEnd.mul(zoom) as NodeArg)
      .oneMinus();

    // Depth at the RAYMARCH HIT, not at the shell. The shell is the terrain
    // lifted by the tallest canopy, so its rasterised depth is up to a
    // canopy-height too near. Left uncorrected, anything standing IN the grass —
    // a soldier, a vehicle — depth-tests against a surface floating above the
    // grass and pops in front of it, which breaks the one thing this system
    // exists for. (This is the integration hurdle for GPU Voxel Space ports:
    // mixing polygonal objects, not raw speed.)
    const hitWorld = cameraPosition.add(V.mul(hitS.max(float(0))));
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
    const shaded: NodeArg = columns.mix(base.rgb, fade.oneMinus());

    // Debug views are selected by a uniform rather than baked in, so they can be
    // switched without rebuilding the material — which would also throw away the
    // terrain geometry cache.
    //   1 = hit mask (flat magenta by height up the column)
    //   2 = hit distance, red near through green to blue far
    //   3 = height up the column, black at the base to white at the tip
    const dbgHit: NodeArg = vec3(1, 0, 1).mul(hitFrac.clamp(0.25, 1));
    const dbgDist: NodeArg = vec3(
      dNorm.oneMinus(),
      dNorm.mul(2).min(dNorm.mul(2).oneMinus().add(1)).clamp(0, 1),
      dNorm
    );
    const dbgFrac: NodeArg = vec3(hitFrac.clamp(0, 1));

    const rgb: NodeArg = uDebugMode
      .lessThan(0.5)
      .select(
        shaded,
        uDebugMode
          .lessThan(1.5)
          .select(dbgHit, uDebugMode.lessThan(2.5).select(dbgDist, dbgFrac))
      );

    return GrassHit(rgb, hit, hitDepth);
  });

  const shaded = grassShade();

  // UNLIT. The colormap is pre-shaded — it already bakes lighting and shadow
  // (docs/06 §6) — and the original renderer applied no lighting at all, it just
  // painted map.color. Running PBR on top double-shades it, and at shell
  // silhouettes the interpolated normal goes edge-on and diffuse collapses to
  // zero, leaving black rim artifacts along the canopy edges.
  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = positionNode;
  // struct field accessors are loosely typed; the graph is validated by running it.
  material.colorNode = shaded.get('rgb') as NodeArg;
  // Alpha-tested rather than blended: grass is opaque where it exists, and this
  // keeps it in the opaque queue with correct depth against the terrain.
  material.opacityNode = shaded.get('hit') as NodeArg;
  // Correct depth so polygonal objects intersect the grass properly. This does
  // disable early-Z for the grass pass — a real cost, accepted because without
  // it nothing can stand in the grass convincingly.
  material.depthNode = shaded.get('depth') as NodeArg;
  material.transparent = false;
  material.alphaTest = 0.5;
  // Double-sided: standing inside the canopy we see the shell from underneath.
  // Lighting is left to the material so three flips normals for back faces —
  // overriding normalNode with a world normal shades every back face black.
  material.side = THREE.DoubleSide;

  return {
    material,
    canopyMax,
    uniforms: {
      grassScale: uGrassScale,
      canopyMax: uCanopyMax,
      cell: uCell,
      tone: uTone,
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
