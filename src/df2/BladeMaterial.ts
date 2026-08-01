// Near-field grass blades — the instanced layer laid OVER the relief march.
//
// Every blade places, sizes, colours and culls itself in the VERTEX stage from the
// same canopy samplers the march reads (grassField.ts), so the two layers agree by
// construction rather than by a CPU copy that can drift. The march still draws the
// dense canopy underneath; blades only add silhouette and wind in the first metres.

import * as THREE from "three/webgpu";
import {
  float,
  vec2,
  vec3,
  uniform,
  texture,
  uv,
  positionLocal,
  cameraPosition,
  instanceIndex,
  varying,
  time,
  mx_noise_float,
} from "three/tsl";
import type { GrassField } from "./grassField";

export interface BladeMaterialOptions {
  /** The canopy samplers the MARCH was built from. Not a copy — the same object. */
  field: GrassField;
  /** Colormap — the source of each blade's colour, exactly as for a column. */
  colorMap: THREE.Texture;
  /** Requested instance pool. Rounded to a square so the lattice is regular. */
  count: number;
  /** Half-extent of the square field, metres. */
  radius: number;
  /** Distance at which stochastic thinning starts, metres. */
  thinStart: number;
  /** Keep probability at the field edge. */
  keepMin: number;
  /** Exponent applied to the canopy value before it becomes a keep probability. */
  densityGamma: number;
  /** Multiplier on the march's own column height. 1 stands a blade among equals. */
  heightScale: number;
  /** Resting lean as a fraction of blade height, peak to peak. */
  bend: number;
  /** Twist of the section about the blade axis, radians at the tip, peak to peak. */
  twist: number;
  /** Tip displacement per metre of height per m/s of wind. */
  windGain: number;
  /** Noise lattice units per metre — the size of a gust. */
  noiseScale: number;
  /** Noise drift in lattice units per second per m/s of wind. */
  gustRate: number;
  /** Peak-to-peak per-column tone variation. Shared with the march. */
  toneVariation: number;
  /** Brightness at the blade's base; the tip gets 2 - this. Contrast along one blade. */
  shadeBase: number;
  /** Brightness of the layer against the march behind it. See GRASS_BLADE_LIFT. */
  lift: number;
  /** Initial horizontal wind, m/s. Authoritative — it is what drifts bullets. */
  wind: { x: number; z: number };
  /** Debug view: 0 normal, 1 keep mask, 2 distance. See `?bladedebug=`. */
  debug?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

// TSL's constructors are typed per component, and the graph here is built from
// expressions whose component types TypeScript cannot follow through `.mul()`. Loose
// aliases, as elsewhere in this renderer: the graph is validated by compiling it.
const V2 = vec2 as unknown as (x: NodeArg, y?: NodeArg) => NodeArg;
const V3 = vec3 as unknown as (x: NodeArg, y: NodeArg, z: NodeArg) => NodeArg;

export interface BladeMaterial {
  material: THREE.MeshBasicNodeMaterial;
  /** Instances to draw. The square of the lattice side, so not exactly `count`. */
  count: number;
  uniforms: {
    radius: NodeArg;
    thinStart: NodeArg;
    keepMin: NodeArg;
    densityGamma: NodeArg;
    heightScale: NodeArg;
    shadeBase: NodeArg;
    lift: NodeArg;
    /** Horizontal wind in m/s. Assign from BallisticEnvironment, never from taste. */
    wind: NodeArg;
    windGain: NodeArg;
  };
}

export function createBladeMaterial(opts: BladeMaterialOptions): BladeMaterial {
  const {
    field,
    colorMap,
    count,
    radius,
    thinStart,
    keepMin,
    densityGamma,
    heightScale,
    bend,
    twist,
    windGain,
    noiseScale,
    gustRate,
    toneVariation,
    shadeBase,
    lift,
    wind,
    debug = 0,
  } = opts;

  // A SQUARE LATTICE, one blade per cell, and the reason is stability rather than
  // tidiness. The per-blade random has to key on the WORLD cell so a blade keeps its
  // identity as the field wraps around a moving camera; anything keyed on the instance
  // index instead makes every blade swap its bend, height and lean each time the field
  // shifts, which reads as the whole near field twitching once per step.
  //
  // Keying on the world cell also means the pattern is exactly stationary in world
  // space, which is the property a scatter cannot have: a randomly-placed field snapped
  // to a grid slides bodily with the camera.
  const side = Math.max(1, Math.round(Math.sqrt(Math.max(1, count))));
  const half = Math.floor(side / 2);
  const instances = side * side;

  const uRadius = uniform(radius);
  const uThinStart = uniform(thinStart);
  const uKeepMin = uniform(keepMin);
  const uGamma = uniform(densityGamma);
  const uHeightScale = uniform(heightScale);
  const uBend = uniform(bend);
  const uTwist = uniform(twist);
  const uWind = uniform(new THREE.Vector2(wind.x, wind.z));
  const uWindGain = uniform(windGain);
  const uNoiseScale = uniform(noiseScale);
  const uGustRate = uniform(gustRate);
  const uTone = uniform(toneVariation);
  const uShadeBase = uniform(shadeBase);
  const uLift = uniform(lift);
  /** 0 normal, 1 keep mask, 2 distance. Live, so the debug panel could drive it. */
  const uDebug = uniform(debug);

  /**
   * Stable per-blade random, keyed on the world cell.
   *
   * The same sin-free hash the march uses for per-strand height (`strandHash`), for
   * the same two reasons: it costs about six ALU operations rather than a texture
   * fetch, and it wraps its input first. Cell indices here are world-metres over a
   * ~0.19 m cell, so they reach the thousands, and `fract()` on values that large has
   * no bits left to vary — the hash would quietly degenerate to a constant.
   */
  const rnd = (cell: NodeArg, salt: number): NodeArg => {
    const c = cell.add(V2(salt * 37.13, salt * 91.71));
    const w = c.sub(c.mul(1 / 4096).floor().mul(4096));
    const p = w.mul(V2(0.1031, 0.103)).fract().toVar();
    p.addAssign(p.dot(V2(p.y, p.x).add(33.33)));
    return p.x.add(p.y).mul(p.x).fract();
  };
  /** The same, mapped to [-1, 1] — the reference's "signed seed". */
  const signed = (cell: NodeArg, salt: number): NodeArg => rnd(cell, salt).mul(2).sub(1);

  // --- which cell is this instance standing in -------------------------------
  const cellSize = uRadius.mul(2 / side);
  const camXZ = V2(cameraPosition.x, cameraPosition.z);
  const fi = float(instanceIndex);
  const iz = fi.mul(1 / side).floor();
  const ix = fi.sub(iz.mul(side));
  // Integer world cell: the camera's own cell, plus this instance's fixed offset
  // within the window. As the camera walks, cells enter and leave the window and each
  // one always produces the same blade.
  const worldCell = camXZ.div(cellSize).floor().add(V2(ix.sub(half), iz.sub(half)));
  // Jittered inside its own cell, so the lattice never shows as rows.
  const bladeXZ = worldCell
    .add(0.5)
    .mul(cellSize)
    .add(V2(rnd(worldCell, 1), rnd(worldCell, 2)).sub(0.5).mul(cellSize));

  // --- how tall it stands, from the march's own formula -----------------------
  // `columnTop` is the expression the march intersects, called rather than copied, so
  // a blade is exactly as tall as the columns around it and there is no height seam to
  // tune away. `meshMipAt` puts it on the terrain LOD surface the mesh is drawing, and
  // `groundAt` inside it applies the half-texel correction every consumer of the height
  // map needs (docs/08 §11) — without which blades float or sink on slopes and shift as
  // the camera turns.
  const mip = field.meshMipAt(bladeXZ);
  const column = field.columnTop(bladeXZ, mip);
  const height = column.top.sub(column.ground).mul(uHeightScale).max(float(0));

  // --- and whether it exists at all, in ONE test ------------------------------
  // Canopy density and distance thinning multiply into a single probability tested
  // against one stable random. Stochastic rather than a fade because opacity here would
  // feed an alpha test, and the codebase already recorded that a crossfade through a
  // binary test collapses into a hard ring (the fade note in GrassMaterial).
  //
  // Bare ground therefore grows nothing — 11.2% of Green Mile (docs/06 §7.1) — short
  // canopy grows sparse blades, and the field edge is rare rather than absent.
  const canopyN = field.canopyBase(column.centre).div(field.canopyMax).clamp(0, 1);
  const density = canopyN.pow(uGamma);
  const dist = bladeXZ.distance(camXZ);
  const far = dist.smoothstep(uThinStart, uRadius);
  // Interpolant is the receiver: mix(1, keepMin, far).
  const keep = far.mix(float(1), uKeepMin);
  const alive = rnd(worldCell, 3).lessThan(density.mul(keep)).select(float(1), float(0));
  // The debug views draw EVERY instance, including the ones the test rejected. That is
  // the only way to see what the pool is spending itself on: a rejected blade collapses
  // to zero area, so a 90%-wasted pool and a correctly-sized one look identical.
  const drawn = uDebug.greaterThan(float(0.5)).select(float(1), alive);
  const vAlive: NodeArg = varying(alive);
  const vDist: NodeArg = varying(dist);

  // --- the blade itself, in its own space -------------------------------------
  const t = uv().y;
  // Width follows the SQUARE ROOT of height, not height itself. Proportional width
  // makes an ankle-high blade — the median on this map — thinner than a grass column
  // and invisible; constant width makes it a paddle.
  const widthScale = height.div(field.canopyMax).clamp(0.06, 1).sqrt();
  const seed = signed(worldCell, 4);

  const scaled = V3(
    positionLocal.x.mul(widthScale),
    positionLocal.y.mul(height),
    positionLocal.z.mul(widthScale)
  );

  // Twist about the blade's own axis, growing toward the tip, so a near-flat blade
  // does not read as a flat card when seen edge-on.
  const twistAngle = seed.mul(uTwist).mul(t);
  const tc = twistAngle.cos();
  const ts = twistAngle.sin();
  const twisted = V3(
    scaled.x.mul(tc).sub(scaled.z.mul(ts)),
    scaled.y,
    scaled.x.mul(ts).add(scaled.z.mul(tc))
  );

  // Resting lean along local +Z. The exponent is per blade so they do not all curve
  // through the same arc; the vertical shortening is the reference's arc-length
  // compensation, without which a bending blade visibly stretches (docs/03 §4.4).
  const bendAmount = signed(worldCell, 5).mul(uBend);
  const curvePower = seed.mul(0.5).add(0.5).mul(1.5).add(2);
  const lean = t.pow(curvePower).mul(bendAmount).mul(height);
  const leaned = V3(twisted.x, twisted.y.sub(lean.abs().mul(0.3)), twisted.z.add(lean));

  // Random heading, so blades do not all face the same way.
  const yaw = rnd(worldCell, 6).mul(Math.PI * 2);
  const yc = yaw.cos();
  const ys = yaw.sin();
  const turned = V3(
    leaned.x.mul(yc).sub(leaned.z.mul(ys)),
    leaned.y,
    leaned.x.mul(ys).add(leaned.z.mul(yc))
  );

  // --- wind: the reason this layer earns its frame time -----------------------
  // The DIRECTION is BallisticEnvironment.windVelocity, which drifts bullets, so the
  // grass a shooter reads for windage cannot disagree with the ballistics. The
  // reference hardcodes +X; copying that would make the instrument lie.
  const windSpeed = uWind.length();
  const windDir = uWind.div(windSpeed.max(float(1e-4)));
  // A height-proportional lag SUBTRACTED from the noise time is what makes a gust
  // travel up the blade instead of the whole blade wobbling in unison, and the
  // per-blade speed offset stops the field pulsing as one.
  const lag = t.mul(1.2).add(bendAmount.mul(0.5));
  const phase = time.mul(uGustRate).mul(windSpeed).mul(seed.mul(0.15).add(1)).sub(lag);
  const ns = uNoiseScale;
  const n1 = mx_noise_float(
    V3(bladeXZ.x.mul(ns).add(phase), bladeXZ.y.mul(ns).add(phase.mul(0.7)), 0)
  );
  const n2 = mx_noise_float(
    V3(bladeXZ.x.mul(ns).mul(2).add(phase.mul(0.8)), bladeXZ.y.mul(ns).mul(2), 0)
  );
  // Anchored at the root by the high power on t, and scaled by the blade's own height
  // so a tall blade leans further in metres than a short one.
  const gust = n1.mul(0.8).add(n2.mul(0.2));
  const windBend = gust
    .mul(t.pow(2.8))
    .mul(1.4)
    .mul(uWindGain)
    .mul(windSpeed)
    .mul(height);
  const blown = V3(
    turned.x.add(windDir.x.mul(windBend)),
    turned.y.sub(windBend.abs().mul(0.3)),
    turned.z.add(windDir.y.mul(windBend))
  );

  // Rejected blades COLLAPSE rather than discarding fragments: every vertex lands on
  // the base point, so the triangles have zero area and cost no fill at all. Discarding
  // in the fragment stage would pay for the fragments before killing them.
  const base = V3(bladeXZ.x, column.ground, bladeXZ.y);
  const world = base.add(blown.mul(drawn));

  // --- colour: from the colormap, never from a palette ------------------------
  // Sampled at the blade's own position and modulated by the same per-column tone the
  // march applies, so a blade over a dark patch is dark. The reference's random
  // green-to-brown palette is rejected outright: the colormap is pre-shaded and a
  // private palette would fight it (docs/03 §4.4).
  //
  // EXPLICIT level 0. There are no derivatives in the vertex stage to select a mip
  // with, and the pale-wash artifact this project already paid for came from exactly
  // that kind of implicit selection.
  const colour = texture(colorMap, field.toUv(bladeXZ)).level(float(0));
  const swingRaw = float(0.5).mix(column.jitter.g, field.strandHash(column.cell));
  // Applied around 1.0 with the downward swing damped, as in the march: the colormap
  // is pre-shaded, so a raw multiply crushes its baked shadows to black.
  const swing = swingRaw.sub(0.5).mul(uTone);
  const tone = swing.max(swing.mul(0.35)).add(1);
  const vColour = varying(colour.rgb.mul(tone));

  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = world;
  // Base-to-tip ramp centred on 1.0, the same one the march applies up a column, so
  // blades and columns shade alike. Interpolant is the receiver.
  const shade = t.clamp(0, 1).mix(uShadeBase, uShadeBase.oneMinus().add(1)).mul(uLift);
  // 0 normal. 1 keep mask: green where the blade survived the canopy and distance test,
  // magenta where it was rejected — magenta filling the frame means the pool is being
  // spent on ground that grows nothing. 2 distance: red at the eye through to blue at
  // the field edge, which shows the extent and where the thinning bites.
  const kept = V3(0.15, 1, 0.25);
  const rejected = V3(1, 0, 0.75);
  const near = vDist.div(uRadius).clamp(0, 1);
  const distanceView = V3(near.oneMinus(), near.mul(near.oneMinus()).mul(4), near);
  const debugView: NodeArg = uDebug
    .lessThan(float(1.5))
    .select(vAlive.greaterThan(float(0.5)).select(kept, rejected), distanceView);
  material.colorNode = (uDebug as NodeArg)
    .lessThan(float(0.5))
    .select(vColour.mul(shade), debugView);
  // DOUBLE-SIDED. Single-sided is the right call for camera-facing sprites, where the
  // back is never seen; for world-anchored geometry backface culling does not save
  // fill, it deletes blades whenever you happen to view them from behind.
  material.side = THREE.DoubleSide;
  // UNLIT and unfogged, like every other material here. Blades live inside 12 m and
  // FOG_NEAR is 300 m, so three's automatic fog would contribute nothing but a term.
  material.fog = false;

  return {
    material,
    count: instances,
    uniforms: {
      radius: uRadius,
      thinStart: uThinStart,
      keepMin: uKeepMin,
      densityGamma: uGamma,
      heightScale: uHeightScale,
      shadeBase: uShadeBase,
      lift: uLift,
      wind: uWind,
      windGain: uWindGain,
    },
  };
}

/**
 * The drawable object.
 *
 * NOT RAYCASTABLE, and that is a hard constraint rather than an optimisation:
 * concealment is authoritative on the march and the CPU heightfield, so blade geometry
 * must never answer a gameplay query. three's Raycaster ignores `visible`, so an
 * un-neutered instanced mesh would report hits to the rangefinder — the same trap the
 * grass cap already documents in Terrain.tsx.
 *
 * NOT FRUSTUM CULLED either. The instances carry identity matrices and place themselves
 * from the camera in the vertex stage, so the bounding sphere three would compute sits
 * at the origin and would cull the whole layer the moment the player walked away.
 */
export function createBladeMesh(
  geometry: THREE.BufferGeometry,
  blade: BladeMaterial
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, blade.material, blade.count);
  const identity = new THREE.Matrix4();
  for (let i = 0; i < blade.count; i++) mesh.setMatrixAt(i, identity);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.raycast = () => {};
  mesh.renderOrder = 2;
  return mesh;
}
