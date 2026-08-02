// Rain and snow — a camera-local instanced particle field, ported from three-geospatial.
//
// Every drop's motion is computed analytically in the node graph from its instance
// index, so there is no compute pass, no storage buffer and no per-frame CPU work beyond
// moving the box onto the camera. Drops loop through a box that travels with the player,
// which is why a few thousand of them read as weather across the whole world.

import * as THREE from "three/webgpu";
import {
  abs,
  cos,
  cross,
  float,
  instanceIndex,
  length,
  mix,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec2,
  cameraPosition,
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

// TSL's constructors are typed per component and cannot follow component types through
// `.mul()`; the graph is validated by compiling it, as elsewhere in this renderer.
const V3 = vec3 as unknown as (x: NodeArg, y: NodeArg, z: NodeArg) => NodeArg;
const V2 = vec2 as unknown as (x: NodeArg, y: NodeArg) => NodeArg;

export interface PrecipitationOptions {
  /**
   * Instance pool at full intensity. Lighter rain draws a coarser lattice, not a prefix
   * of this one — see `setIntensity`.
   *
   * PAIRED WITH `area`, exactly as the blade count is paired with its radius: the box
   * volume divided by the count is the drop spacing, so widening the box at a fixed count
   * thins the rain. The difference from blades is that the extra volume is nearly all far
   * drops, which are sub-pixel — so reach costs density and buys very little, and the
   * reason to widen it at all is that a visible edge where rain stops is worse than
   * slightly thinner rain.
   */
  maxCount?: number;
  /** Width of the box the drops loop inside, metres. Drops span +/- half of it. */
  area?: number;
  /** Height of that box, metres. */
  height?: number;
  /** 0 rain, 1 snow. Blended, so intermediate values are sleet. */
  mode?: number;
  /** Fraction of the pool drawn, 0-1. The density dial. */
  intensity?: number;
  opacity?: number;
  /** Horizontal wind, m/s. The SAME vector the grass bends to and bullets drift on. */
  wind?: { x: number; z: number };
}

export interface PrecipitationUniforms {
  /** 0 rain, 1 snow; between them, sleet. */
  mode: NodeArg;
  opacity: NodeArg;
  fallSpeedRain: NodeArg;
}

export interface Precipitation {
  object3D: THREE.Object3D;
  /** Live dials — assigning `.value` rebuilds nothing. */
  uniforms: PrecipitationUniforms;
  /** Move the field onto the camera. Call every frame. */
  update: (camera: THREE.Camera) => void;
  /**
   * Set the density — the lattice resolution AND the drawn instance count, together.
   *
   * ONE call, deliberately. They were briefly separate and the panel drove only one of
   * them, so the draw range stayed pinned to whatever the preset had last set: the slider
   * could not exceed its preset's rain, and on a dry preset it did nothing at all, which
   * read as rain being gated behind the weather.
   */
  setIntensity: (intensity: number) => void;
  dispose: () => void;
}

export function createPrecipitation(opts: PrecipitationOptions = {}): Precipitation {
  const maxCount = opts.maxCount ?? 60000;
  const wind = opts.wind ?? { x: 0, z: 0 };

  const u = {
    opacity: uniform(opts.opacity ?? 0.05),
    mode: uniform(opts.mode ?? 0),
    // Wind as TWO SCALARS, not a vec2, and this is a trap paid for in the source
    // project: the WebGPU uniform path re-uploads a scalar `.value` reassignment but
    // NOT in-place mutation of an object uniform holding the same reference, so a
    // `uniform(Vector2)` updated with `.set()` silently stayed at zero and wind had no
    // effect at all. Scalars reassign like any other number.
    windX: uniform(wind.x),
    windZ: uniform(wind.z),
    area: uniform(opts.area ?? 80),
    height: uniform(opts.height ?? 55),
    dropLength: uniform(0.9),
    dropWidth: uniform(0.04),
    flakeSize: uniform(0.25),
    fallSpeedRain: uniform(9), // roughly a raindrop's terminal velocity
    fallSpeedSnow: uniform(1.2),
    rainColor: uniform(new THREE.Color(0.72, 0.78, 0.9)),
    snowColor: uniform(new THREE.Color(1, 1, 1)),
    // Submerged: the same drops become slow-rising, sideways-drifting suspended specks
    // rather than bubbles. Wired to the water level in the scene.
    uw: uniform(0),
    uwRise: uniform(0.12),
    uwSize: uniform(0.05),
    uwOpacity: uniform(0.06),
  };

  // WORLD-CELL LATTICE, the same construction the blade layer uses and for the same
  // reason. Keying a drop's scatter on its INSTANCE INDEX ties it to the camera-following
  // box, so every drop's world position translates with the player and the whole field
  // reads as locked to the viewer — rain sliding along with you rather than falling in
  // the world. Keying on the world cell instead makes the pattern stationary: cells enter
  // and leave the window as you walk, and each one always produces the same drop.
  //
  // DENSITY IS THE LATTICE'S RESOLUTION, not a prefix of it. Trimming the draw range to
  // `intensity * count` is the obvious way to thin rain and is wrong: a prefix of a
  // row-major lattice is a block of ROWS, so half intensity meant a half-plane of rain
  // with a hard edge running through the player and nothing at all on the other side.
  // Scaling the side length keeps the box fully covered at every setting and still trims
  // the work, because the drawn count is that side squared.
  const maxSide = Math.max(1, Math.round(Math.sqrt(maxCount)));
  const uSide = uniform(maxSide);
  const cellSize: NodeArg = (u.area as NodeArg).div(uSide);
  const halfSide: NodeArg = (uSide as NodeArg).mul(0.5).floor();
  const camXZ = V2(cameraPosition.x, cameraPosition.z);
  // WHERE THE FIELD HAS BLOWN TO. Wind carries the whole body of rain downwind, so this
  // grows without bound — which is fine for a POSITION and fatal for a WINDOW.
  const windOffset: NodeArg = V2(
    (u.windX as NodeArg).mul(time),
    (u.windZ as NodeArg).mul(time)
  );
  const fi: NodeArg = float(instanceIndex);
  const iz = fi.div(uSide).floor();
  const ix = fi.sub(iz.mul(uSide));
  // The lattice is sampled in the FIELD'S frame, not the world's: the camera position is
  // pulled back by however far the field has blown, so the window stays around the player
  // once the same offset is added back to the drop below.
  //
  // Without that compensation the window sat at the camera while every drop was pushed
  // downwind by wind x time, so the entire cloud drifted away and never came back — 120 m
  // out after thirty seconds at 4 m/s. That is the rain "running away from you", and it is
  // the one thing the blade layer never has to solve, because wind BENDS a blade rather
  // than moving it.
  const worldCell: NodeArg = camXZ
    .sub(windOffset)
    .div(cellSize)
    .floor()
    .add(V2(ix.sub(halfSide), iz.sub(halfSide)));

  // Per-drop randoms from the CELL, not the index — that is the whole change.
  //
  // The SIN-FREE hash grassField.ts uses, and for its documented reason. Cell indices are
  // world-metres over a sub-metre cell, so a few hundred metres out they reach tens of
  // thousands; a hash fed values that large has no bits left to vary and degenerates to a
  // near-constant, stacking every drop at one offset with one phase. Packing the pair as
  // `x + y*512` to feed TSL's single-float `hash` puts the magnitude straight back — this
  // form consumes the pair without ever building a large number, and wraps first anyway.
  const cellHash = (salt: number): NodeArg => {
    const c: NodeArg = worldCell.add(V2(salt * 37.13, salt * 91.71));
    const w: NodeArg = c.sub(c.mul(1 / 512).floor().mul(512));
    const p0: NodeArg = w.mul(V2(0.1031, 0.103)).fract();
    const p: NodeArg = p0.add(p0.dot(V2(p0.y, p0.x).add(33.33)));
    return p.x.add(p.y).mul(p.x).fract();
  };
  const r1: NodeArg = cellHash(0);
  const r2: NodeArg = cellHash(1);
  const r3: NodeArg = cellHash(2);
  const r4: NodeArg = cellHash(3);


  // Mode blends physics AND shape: 0 is a rain streak, 1 a square snowflake.
  const fallSpeed: NodeArg = mix(u.fallSpeedRain, u.fallSpeedSnow, u.mode);
  const dropW: NodeArg = mix(u.dropWidth, u.flakeSize, u.mode);
  const dropL: NodeArg = mix(u.dropLength, u.flakeSize, u.mode);
  const dropWf: NodeArg = mix(dropW, u.uwSize, u.uw);
  const dropLf: NodeArg = mix(dropL, u.uwSize, u.uw);

  // Y IS UP. The source project runs on a globe and rebuilds an east/north/up basis at
  // the camera every frame, because "down" there depends on where you are. This world is
  // flat, so the box needs no orientation at all and the group only translates — which
  // also removes the source's own trap, a left-handed basis that made rain fall upward
  // depending on view angle.
  //
  // Signed vertical velocity: in air drops FALL, submerged they RISE slowly. `mod` loops
  // each drop through the box and handles the negative march cleanly; r3 de-synchronises
  // the phase so they do not fall in ranks.
  const vy: NodeArg = mix((fallSpeed as NodeArg).negate(), u.uwRise, u.uw);

  /**
   * Floor-mod, written out rather than `mod()`.
   *
   * Both arguments here run far negative — a drop's fall is speed times elapsed time,
   * unbounded downward — and a truncating remainder returns the sign of its dividend,
   * which would put half the field below the band instead of wrapped into it.
   */
  const wrap = (x: NodeArg, period: NodeArg): NodeArg =>
    x.sub(x.div(period).floor().mul(period));

  // A TRUE FALL, wrapped into a band that stays centred on the eye.
  //
  // The band used to snap to whole multiples of its own height, which leaves the camera
  // anywhere within it — including above its top, where every drop is below you and you
  // see no rain at all. Since the snap is keyed on the camera's ALTITUDE, that made rain
  // appear and vanish in horizontal slabs of terrain height: walk uphill far enough and
  // you walk out of the weather. Wrapping each drop to the nearest band around the eye
  // instead centres the camera exactly, at every altitude, and puts the wrap half a band
  // away — the farthest point from the viewer rather than right at it.
  const halfH: NodeArg = (u.height as NodeArg).mul(0.5);
  const phase: NodeArg = wrap(r3.mul(u.height).add(vy.mul(time)), u.height);
  const upPos: NodeArg = cameraPosition.y.add(
    wrap(phase.sub(cameraPosition.y).add(halfH), u.height).sub(halfH)
  );

  // Surface wind drives drops in air and fades out under water, so submerged specks
  // drift on the gentle sway below rather than at wind speed.
  const windX: NodeArg = (u.windX as NodeArg).mul((u.uw as NodeArg).oneMinus());
  const windZ: NodeArg = (u.windZ as NodeArg).mul((u.uw as NodeArg).oneMinus());

  // Jittered inside its own cell so the lattice never shows as rows, plus a wind offset
  // applied to the WHOLE field. A shared offset is the physically right shape: wind moves
  // the entire body of rain downwind together, so the pattern translates rather than each
  // drop wandering out of its cell.
  // Jittered inside its own cell so the lattice never shows as rows, then carried
  // downwind by the same offset the window was pulled back by. The two cancel, so drops
  // stream past the player forever instead of the cloud leaving.
  const cellCentre: NodeArg = worldCell.add(0.5).mul(cellSize);
  const driftX = cellCentre.x.add(r1.sub(0.5).mul(cellSize)).add(windOffset.x);
  const driftZ = cellCentre.y.add(r2.sub(0.5).mul(cellSize)).add(windOffset.y);

  // Snow flutters; submerged specks drift gently sideways for a suspended look.
  const swayAmp: NodeArg = (u.flakeSize as NodeArg).mul(6).mul(u.mode);
  const uwSway: NodeArg = float(1.5).mul(u.uw);
  const px = driftX
    .add(sin(time.mul(1.6).add(r4.mul(6.2832))).mul(swayAmp))
    .add(sin(time.mul(0.4).add(r4.mul(6.2832))).mul(uwSway));
  const pz = driftZ
    .add(cos(time.mul(1.3).add(r4.mul(6.2832))).mul(swayAmp))
    .add(cos(time.mul(0.35).add(r4.mul(6.2832))).mul(uwSway));
  // WORLD position now, not an offset from a camera-following box.
  const centre: NodeArg = V3(px, upPos, pz);

  // NO PER-DROP VISIBILITY TEST. The drawn count is exactly the lattice's side squared,
  // so every instance that runs maps to a live cell — there is nothing to reject.
  //
  // A streak aligned to the drop's own velocity, not to the camera. Its LENGTH runs
  // along the direction of travel, so it foreshortens to a dot when you look straight up
  // or down the rain — which a fixed camera-facing sprite cannot do. Its WIDTH turns to
  // face the camera, perpendicular to both the velocity and the view ray.
  const velLocal: NodeArg = normalize(V3(windX, vy, windZ));
  const toCam: NodeArg = normalize(cameraPosition.sub(centre));
  // The epsilon keeps the cross product finite for a drop sitting exactly on the view axis.
  const widthAxis: NodeArg = normalize(cross(velLocal, toCam).add(V3(1e-4, 0, 0)));
  const g: NodeArg = positionGeometry; // plane vertices, x and y in [-0.5, 0.5]
  const offset = widthAxis.mul(g.x.mul(dropWf)).add(velLocal.mul(g.y.mul(dropLf)));

  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  // DEPTH TESTED, unlike the source. There it composites in a post-processing overlay
  // after the atmosphere, so depth is meaningless and disabled; here rain is ordinary
  // scene geometry inside a 35 m box, and terrain a few metres ahead has to occlude the
  // drops behind it. Depth WRITE stays off, as for any transparent particle.
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.DoubleSide;
  material.positionNode = (centre as NodeArg).add(offset);

  // uv.x runs across the streak's width, uv.y along its length.
  const a: NodeArg = (uv() as NodeArg).sub(0.5);
  const rainAlpha = smoothstep(float(0.5), float(0), abs(a.x)).mul(
    smoothstep(float(0.5), float(0), abs(a.y))
  );
  const snowAlpha = smoothstep(float(0.5), float(0), length(a));
  const airShape: NodeArg = mix(rainAlpha, snowAlpha, u.mode);
  const shapeAlpha: NodeArg = mix(airShape, snowAlpha, u.uw);
  const effOpacity: NodeArg = mix(u.opacity, u.uwOpacity, u.uw);
  material.opacityNode = shapeAlpha.mul(effOpacity);
  material.colorNode = mix(u.rainColor, u.snowColor, u.mode);
  material.fog = false;

  // An InstancedBufferGeometry rather than an InstancedMesh, for the reason the blade
  // layer documents: placement lives entirely in the node graph, so a per-instance matrix
  // would be 16 floats each of identity, uploaded and then multiplied by every vertex.
  const geometry = new THREE.InstancedBufferGeometry();
  const plane = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute("position", plane.getAttribute("position"));
  geometry.setAttribute("uv", plane.getAttribute("uv"));
  geometry.setIndex(plane.getIndex());
  plane.dispose();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // positions live in the node graph, not in the bounds
  mesh.renderOrder = 12; // after opaque geometry, for transparency sorting
  mesh.raycast = () => {}; // weather answers no gameplay query

  const setIntensity = (intensity: number): void => {
    const v = Math.max(0, Math.min(1, intensity));
    // Square root, so the DRAWN COUNT — the side squared — is linear in intensity while
    // the box stays fully covered. The pool is a draw count, not an allocation, so
    // raising the dial again costs nothing.
    const s = Math.max(1, Math.round(maxSide * Math.sqrt(v)));
    uSide.value = s;
    geometry.instanceCount = s * s;
    mesh.visible = v > 0;
  };
  setIntensity(opts.intensity ?? 0);

  return {
    object3D: mesh,
    uniforms: {
      mode: u.mode,
      opacity: u.opacity,
      fallSpeedRain: u.fallSpeedRain,
    },
    // NOTHING TO UPDATE. Every drop derives its own world position from `cameraPosition`
    // in the vertex stage, so the mesh sits at the origin and never moves — the same
    // arrangement the blade layer uses, and it removes a per-frame matrix update too.
    update: () => {},
    setIntensity,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
