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
  hash,
  instanceIndex,
  length,
  mix,
  mod,
  normalize,
  positionGeometry,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

// TSL's constructors are typed per component and cannot follow component types through
// `.mul()`; the graph is validated by compiling it, as elsewhere in this renderer.
const V3 = vec3 as unknown as (x: NodeArg, y: NodeArg, z: NodeArg) => NodeArg;

export interface PrecipitationOptions {
  /**
   * Instance pool. Only `intensity * maxCount` of them are ever drawn.
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
   * Set the density — the uniform AND the drawn instance range, together.
   *
   * ONE call, deliberately. They were briefly separate and the panel drove only the
   * uniform, so the draw range stayed pinned to whatever the preset had last set: the
   * slider could not exceed its preset's rain, and on a dry preset it did nothing at all,
   * which read as rain being gated behind the weather. Any dial that moves one must move
   * the other.
   */
  setIntensity: (intensity: number) => void;
  dispose: () => void;
}

export function createPrecipitation(opts: PrecipitationOptions = {}): Precipitation {
  const maxCount = opts.maxCount ?? 24000;
  const wind = opts.wind ?? { x: 0, z: 0 };

  const u = {
    intensity: uniform(opts.intensity ?? 0),
    opacity: uniform(opts.opacity ?? 0.05),
    mode: uniform(opts.mode ?? 0),
    // Wind as TWO SCALARS, not a vec2, and this is a trap paid for in the source
    // project: the WebGPU uniform path re-uploads a scalar `.value` reassignment but
    // NOT in-place mutation of an object uniform holding the same reference, so a
    // `uniform(Vector2)` updated with `.set()` silently stayed at zero and wind had no
    // effect at all. Scalars reassign like any other number.
    windX: uniform(wind.x),
    windZ: uniform(wind.z),
    area: uniform(opts.area ?? 60),
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
    maxCount: uniform(maxCount),
  };

  // Per-drop deterministic randoms from the instance index — stable across frames, so
  // each drop keeps its scatter and phase with nothing stored anywhere.
  const idx: NodeArg = float(instanceIndex);
  const r1: NodeArg = hash(idx);
  const r2: NodeArg = hash(idx.add(13.17));
  const r3: NodeArg = hash(idx.add(31.41));
  const r4: NodeArg = hash(idx.add(57.93));

  const half: NodeArg = (u.area as NodeArg).mul(0.5);

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
  const upPos: NodeArg = mod(r3.mul(u.height).add(vy.mul(time)), u.height).sub(
    (u.height as NodeArg).mul(0.5)
  );

  // Surface wind drives drops in air and fades out under water, so submerged specks
  // drift on the gentle sway below rather than at wind speed.
  const windX: NodeArg = (u.windX as NodeArg).mul((u.uw as NodeArg).oneMinus());
  const windZ: NodeArg = (u.windZ as NodeArg).mul((u.uw as NodeArg).oneMinus());

  // Scatter plus continuous wind drift, wrapped back into the box so the field stays
  // seamless however far the wind carries it.
  const x0 = r1.sub(0.5).mul(u.area);
  const z0 = r2.sub(0.5).mul(u.area);
  const driftX = mod(x0.add(windX.mul(time)).add(half), u.area).sub(half);
  const driftZ = mod(z0.add(windZ.mul(time)).add(half), u.area).sub(half);

  // Snow flutters; submerged specks drift gently sideways for a suspended look.
  const swayAmp: NodeArg = (u.flakeSize as NodeArg).mul(6).mul(u.mode);
  const uwSway: NodeArg = float(1.5).mul(u.uw);
  const px = driftX
    .add(sin(time.mul(1.6).add(r4.mul(6.2832))).mul(swayAmp))
    .add(sin(time.mul(0.4).add(r4.mul(6.2832))).mul(uwSway));
  const pz = driftZ
    .add(cos(time.mul(1.3).add(r4.mul(6.2832))).mul(swayAmp))
    .add(cos(time.mul(0.35).add(r4.mul(6.2832))).mul(uwSway));
  const centre: NodeArg = V3(px, upPos, pz);

  // Only the first `intensity * maxCount` drops exist. Rejected ones collapse to zero
  // area rather than discarding fragments — the same trick the blade layer uses.
  const visible = idx.lessThan((u.maxCount as NodeArg).mul(u.intensity));
  const vis: NodeArg = visible.select(float(1), float(0));

  // A streak aligned to the drop's own velocity, not to the camera. Its LENGTH runs
  // along the direction of travel, so it foreshortens to a dot when you look straight up
  // or down the rain — which a fixed camera-facing sprite cannot do. Its WIDTH turns to
  // face the camera, perpendicular to both the velocity and the view ray.
  const velLocal: NodeArg = normalize(V3(windX, vy, windZ));
  const toCam: NodeArg = normalize((centre as NodeArg).negate());
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
  material.positionNode = (centre as NodeArg).add(offset.mul(vis));

  // uv.x runs across the streak's width, uv.y along its length.
  const a: NodeArg = (uv() as NodeArg).sub(0.5);
  const rainAlpha = smoothstep(float(0.5), float(0), abs(a.x)).mul(
    smoothstep(float(0.5), float(0), abs(a.y))
  );
  const snowAlpha = smoothstep(float(0.5), float(0), length(a));
  const airShape: NodeArg = mix(rainAlpha, snowAlpha, u.mode);
  const shapeAlpha: NodeArg = mix(airShape, snowAlpha, u.uw);
  const effOpacity: NodeArg = mix(u.opacity, u.uwOpacity, u.uw);
  material.opacityNode = shapeAlpha.mul(effOpacity).mul(vis);
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
  geometry.instanceCount = maxCount;
  plane.dispose();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // positions live in the node graph, not in the bounds
  mesh.renderOrder = 12; // after opaque geometry, for transparency sorting
  mesh.raycast = () => {}; // weather answers no gameplay query

  const position = new THREE.Vector3();
  return {
    object3D: mesh,
    uniforms: {
      mode: u.mode,
      opacity: u.opacity,
      fallSpeedRain: u.fallSpeedRain,
    },
    update: (camera) => {
      camera.getWorldPosition(position);
      mesh.position.copy(position);
    },
    setIntensity: (intensity) => {
      const v = Math.max(0, Math.min(1, intensity));
      u.intensity.value = v;
      // Rejected drops collapse to zero area, but only after their vertex shader has run
      // four hashes, six trig calls and a normalize — so the drawn range is trimmed too,
      // not just the shader's visibility test. The pool stays allocated, so raising the
      // slider again costs nothing.
      geometry.instanceCount = Math.min(maxCount, Math.ceil(maxCount * v));
      mesh.visible = v > 0;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
