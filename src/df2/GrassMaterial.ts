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
//   1. The canopy field is sampled with NEAREST, so columns are discrete blocks
//      with hard vertical edges rather than a smooth interpolated surface.
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
  cameraPosition,
} from "three/tsl";

export interface GrassMaterialOptions {
  /** Per-texel canopy height, 0-255, NEAREST-filtered. */
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
  /** Raymarch steps. 16-24 is plenty; cost is per-fragment, not per-blade. */
  steps?: number;
  /** Distance (m) at which columns start fading into the colormap. */
  fadeStart?: number;
  fadeEnd?: number;
}

export interface GrassMaterial {
  material: THREE.MeshStandardNodeMaterial;
  /** Metres the shell is lifted above the terrain — also the tallest canopy. */
  canopyMax: number;
  /** Live-tunable graph inputs (see setScale for the derived ones). */
  uniforms: Record<string, ReturnType<typeof uniform>>;
  /** Re-derive world/height scaling when the calibration dials change. */
  setScale(metersPerTexel: number, heightScale: number, grassScale: number): void;
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
    fadeStart = 420,
    fadeEnd = 700,
  } = opts;

  const canopyMax = 255 * grassScale;

  const uWorldSize = uniform(worldSize);
  const uHalfWorld = uniform(worldSize / 2);
  const uTexel = uniform(worldSize / mapSize); // metres per map texel
  const uHeightScale = uniform(heightScale * 255);
  const uGrassScale = uniform(grassScale * 255);
  const uCanopyMax = uniform(canopyMax);
  const uFadeStart = uniform(fadeStart);
  const uFadeEnd = uniform(fadeEnd);

  // TSL node types are structurally intricate; these graph helpers take nodes
  // loosely. The graph is validated by compiling and running it, not by tsc.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type NodeArg = any;

  // World xz -> tile uv. Maps repeat, so values outside [0,1] are fine.
  const toUv = (xz: NodeArg): NodeArg => xz.add(uHalfWorld).div(uWorldSize);

  // Quantise a world xz to its map-texel centre, so every sample within one
  // column returns the same value — this is what makes columns coherent.
  const quantise = (xz: NodeArg): NodeArg => xz.div(uTexel).floor().add(0.5).mul(uTexel);

  const groundAt = (xz: NodeArg): NodeArg =>
    texture(heightMap, toUv(xz)).r.mul(uHeightScale);

  const canopyAt = (xz: NodeArg): NodeArg =>
    texture(grassMap, toUv(xz)).r.mul(uGrassScale);

  // Cheap per-column hash for tone variation ("corduroy", docs/07 §1.4).
  const columnHash = (xz: NodeArg): NodeArg => {
    const c = xz.div(uTexel).floor();
    return c.x.mul(127.1).add(c.y.mul(311.7)).sin().mul(43758.5453).fract();
  };

  // --- vertex: lift the terrain shell to the top of the canopy volume -------
  const positionNode = positionLocal.add(vec3(0, uCanopyMax, 0));

  // --- fragment: march down through the volume ------------------------------
  // One graph function does march + shading and returns vec4(rgb, hit): TSL
  // functions return a single node, and calling it once lets both colorNode and
  // opacityNode share the result instead of marching twice.
  const grassShade = Fn(() => {
    const frag = positionWorld;
    const V = frag.sub(cameraPosition).normalize();

    // When the camera stands INSIDE the canopy — which is the whole point of
    // this system — the shell is above the eye and we're looking at its
    // underside, so the ray must start at the camera, not at the rasterised
    // fragment. Otherwise the near field renders no grass at all.
    const camXZ = vec2(cameraPosition.x, cameraPosition.z);
    const inside: NodeArg = cameraPosition.y.lessThan(groundAt(camXZ).add(uCanopyMax));
    const P0: NodeArg = inside.select(cameraPosition, frag);

    // Vertical extent to cross is the canopy depth; convert to a ray length via
    // the ray's downward component, clamped so near-horizontal views stay bounded.
    const down = V.y.negate().max(float(0.06));
    const stepLen = uCanopyMax.div(down).min(float(90)).div(float(steps));

    const hit = float(0).toVar();
    const hitFrac = float(0).toVar(); // 0 at the column base, 1 at its tip
    const hitXZ = vec2(0, 0).toVar();

    Loop(steps, ({ i }) => {
      const t = float(i).add(0.5).mul(stepLen);
      const P = P0.add(V.mul(t));
      const xz = vec2(P.x, P.z);

      const ground = groundAt(xz);
      const canopy = canopyAt(xz);

      // The original's question, asked per fragment instead of per screen column:
      // is this point below the top of the grass column standing here?
      If(P.y.lessThanEqual(ground.add(canopy)).and(P.y.greaterThanEqual(ground)), () => {
        hit.assign(1);
        hitFrac.assign(P.y.sub(ground).div(canopy.max(float(0.001))));
        hitXZ.assign(xz);
        Break();
      });

      // Dropped below the ground: no column here, let the terrain show through.
      If(P.y.lessThan(ground), () => {
        Break();
      });
    });

    // Colour: ONE value per column, sampled at its quantised texel centre and
    // smeared up the whole column. This is what produces vertical striations
    // rather than soft volumetric grass (docs/07 §1.1).
    const base = texture(colorMap, toUv(quantise(hitXZ)));

    // Vertical shading within the column: dark at the base where light doesn't
    // reach, brighter toward the tip — this is what makes the striations read.
    const shade = float(0.42).mix(float(1.14), hitFrac.clamp(0, 1));
    const tone = columnHash(hitXZ).mul(0.16).add(0.92); // per-column tint jitter

    // Fade columns into the colormap with distance; the colormap is already
    // grass-coloured at 100% coverage, so the handover is invisible.
    const fade = frag.distance(cameraPosition).smoothstep(uFadeEnd, uFadeStart);

    return vec4(base.rgb.mul(shade).mul(tone), hit.mul(fade));
  });

  const shaded = grassShade();

  const material = new THREE.MeshStandardNodeMaterial({
    roughness: 1.0,
    metalness: 0.0,
  });
  material.positionNode = positionNode;
  material.colorNode = shaded.xyz;
  // Alpha-tested rather than blended: grass is opaque where it exists, and this
  // keeps it in the opaque queue with correct depth against the terrain.
  material.opacityNode = shaded.w;
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
      worldSize: uWorldSize,
      halfWorld: uHalfWorld,
      texel: uTexel,
      heightScale: uHeightScale,
      grassScale: uGrassScale,
      canopyMax: uCanopyMax,
      fadeStart: uFadeStart,
      fadeEnd: uFadeEnd,
    },
    setScale(metersPerTexel: number, heightScaleM: number, grassScaleM: number) {
      const world = mapSize * metersPerTexel;
      uWorldSize.value = world;
      uHalfWorld.value = world / 2;
      uTexel.value = metersPerTexel;
      uHeightScale.value = heightScaleM * 255;
      uGrassScale.value = grassScaleM * 255;
      uCanopyMax.value = grassScaleM * 255;
    },
  };
}
