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
  /** Raymarch steps. Cost is per-fragment, not per-blade. */
  steps?: number;
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
   * Steps per screen pixel. The march step is derived from the camera's actual
   * angular resolution, so it is NOT a fixed fraction of distance.
   *
   * Whether a column is sub-pixel depends on FIELD OF VIEW, not range. Through a
   * 10x scope a 65 deg view becomes ~6.5 deg and angular resolution rises 10x,
   * so grass at 400 m that was sub-pixel unaided now covers ~10 px. A constant
   * distance-proportional step would be 10x too coarse exactly when a sniper is
   * looking hardest — and this is the range the concealment mechanic is defined
   * at, so the render and the gameplay query must not disagree there.
   *
   * 1.0 = one march step per pixel of angular size. Lower is finer and costlier.
   */
  pixelsPerStep?: number;
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

export interface GrassMaterial {
  material: THREE.MeshBasicNodeMaterial;
  /** Metres the shell is lifted above the terrain — also the tallest canopy. */
  canopyMax: number;
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
    steps = 20,
    cellSize = 0.35,
    pixelsPerStep = 1.0,
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
  // Step growth per unit distance — keeps each step near one pixel wide, the
  // same trade the original made with its increasing deltaz.
  const uPixelsPerStep = uniform(pixelsPerStep);
  const uNearClip = uniform(nearClip);
  const uHeightScale = uniform(heightScale * 255);
  const uGrassScale = uniform(grassScale * 255);
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
    const P0: NodeArg = inside.select(cameraPosition, frag);
    // Distance from the EYE to where this march begins: zero when starting at the
    // eye, the fragment's own range when starting on the shell. The step size is
    // derived from this rather than from the ray-local `t`, which is what the
    // pixel-size argument below was always about.
    const eyeBase: NodeArg = inside.select(float(0), frag.distance(cameraPosition));

    // --- adaptive march, constant angular resolution ------------------------
    // A uniform grid DDA tests every column exactly once, which is ideal near
    // the camera but caps reach at steps*cellSize — at 0.06 m cells that is
    // under 6 m, so everything beyond simply had no grass.
    //
    // The original solved this by growing its step with distance (`deltaz`
    // starts at one texel and increments +0.005 per iteration). Same idea here:
    // step at the column width up close, then grow proportionally to distance so
    // each step stays roughly one pixel wide. Columns stay exactly resolved
    // where they are resolvable, and beyond that they are sub-pixel anyway, so
    // sampling them individually buys nothing.
    const cellW = uCell;
    const t = float(0).toVar();
    const hit = float(0).toVar();
    const hitFrac = float(0).toVar(); // 0 at the column base, 1 at its tip
    const hitXZ = vec2(0, 0).toVar();
    const hitCell = vec2(0, 0).toVar();
    const hitT = float(0).toVar(); // ray distance to the hit, for depth output

    // Start just clear of the column the eye occupies. Standing inside the
    // canopy, that column trivially contains the ray origin, so testing it would
    // make every fragment hit at t~0 in the SAME cell and fill the screen with
    // one flat colour instead of the silhouette you should see lying in it.
    t.assign(inside.select(uNearClip, float(0)));

    // Vertical angular size of one pixel: projection[1][1] = 1/tan(fovY/2), so
    // the half-height in radians is 1/P11 and one pixel spans 2/(P11 * height).
    // Deriving it this way means a scope narrowing the FOV automatically
    // tightens the march instead of needing a separate LOD path.
    const pixelAngle = float(2)
      .div((cameraProjectionMatrix as NodeArg)[1].y.mul(screenSize.y))
      .mul(uPixelsPerStep);

    Loop(steps, () => {
      // Step at the column width up close, then at whatever spans one pixel.
      // Keyed on distance from the EYE, not on `t`. `t` restarts at zero for every
      // fragment, so the pixel term never overtook the column-width floor and the
      // step stayed at its finest for the whole budget — capping total ray length
      // at steps*cellSize regardless of range.
      const step = cellW.max(eyeBase.add(t).mul(pixelAngle));
      const tNext = t.add(step);

      const P = P0.add(V.mul(t));
      const cell = vec2(P.x, P.z).div(cellW).floor();
      const centre = cell.add(0.5).mul(cellW);

      const ground = groundAt(centre);
      // Per-column height: the smooth envelope says where grass grows; clumped
      // noise gives each column its own height, which is what makes the canopy
      // top ragged and the striations legible in silhouette (docs/07 §1.3).
      const jitter = clump(cell, 0).mul(0.62).add(0.38);
      const top = ground.add(canopyBase(centre).mul(jitter));

      const yIn = P0.y.add(V.y.mul(t));
      const yOut = P0.y.add(V.y.mul(tNext));

      // Segment-vs-column overlap across this step.
      If(yIn.min(yOut).lessThanEqual(top).and(yIn.max(yOut).greaterThanEqual(ground)), () => {
        hit.assign(1);
        const yFirst = yIn.min(top).max(ground);
        hitFrac.assign(yFirst.sub(ground).div(top.sub(ground).max(float(0.001))));
        hitXZ.assign(centre);
        hitCell.assign(cell);
        hitT.assign(
          V.y.abs().greaterThan(float(1e-5)).select(yFirst.sub(P0.y).div(V.y), t)
        );
        Break();
      });

      // Ray has dropped below the ground: nothing further can occlude.
      If(yOut.lessThan(ground), () => {
        Break();
      });

      t.assign(tNext);
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
    const swing = clump(hitCell, 17.3).sub(0.5).mul(uTone);
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
    const hitWorld = P0.add(V.mul(hitT.max(float(0))));
    const viewZ = cameraViewMatrix.mul(vec4(hitWorld, 1)).z;
    const hitDepth = viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar);

    // Distance debug: red near -> green mid -> blue far, banded every 100 m so
    // it is obvious whether a suspect region is hitting nearby grass or grass
    // hundreds of metres away seen over a ridge.
    const dNorm = hitT.div(float(600)).clamp(0, 1);

    // The handover to the colormap is a COLOUR blend, not an opacity ramp.
    // opacityNode feeds an alpha TEST at 0.5 with blending off, so a binary `hit`
    // multiplied by `fade` collapsed the entire 700->1100 m cross-fade into a hard
    // ring at the midpoint, where grass switched off inside one pixel. Blending
    // the column tone toward the plain colormap makes the handover invisible,
    // which is what this fade always claimed to do — and it keeps opacity binary,
    // which is the only thing an alpha test can express.
    const columns: NodeArg = base.rgb.mul(shade).mul(tone);
    const rgb = debugDistance
      ? vec3(dNorm.oneMinus(), dNorm.mul(2).min(dNorm.mul(2).oneMinus().add(1)).clamp(0, 1), dNorm)
      : debugHit
        ? vec3(1, 0, 1).mul(hitFrac.clamp(0.25, 1))
        : columns.mix(base.rgb, fade.oneMinus());

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

  return { material, canopyMax };
}
