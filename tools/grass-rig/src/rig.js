// Grass shader test rig.
//
// Renders ONE frame from a fixed, known-grassy vantage at soldier eye height and
// exposes the canvas as a data URL. Deliberately minimal — no HUD, no tiling, no
// controls — so it renders fast enough under software rasterisation to iterate
// on the shader and measure the result objectively.

import * as THREE from "three/webgpu";
import { texture, uv } from "three/tsl";
import { createGrassMaterial } from "../../../src/df2/GrassMaterial";
// The app's own stand-in canopy, not a copy of it. The rig had reimplemented this,
// so the thing being measured could drift from the thing that ships.
import { grassFromColormap } from "../../../src/df2/loadTerrain";

// Teal-leaning camo green. Deliberately not a saturated marker colour: a target
// that reads clearly against grass would flatter the concealment test.
export const TARGET_COLOR = 0x3e7f6e;

const MPT = 2.0; // metres per texel
const HS = 1.0; // metres per raw elevation unit
const EYE_DEFAULT = 1.7;

function imageRgba(img) {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  return x.getImageData(0, 0, img.width, img.height).data;
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}

function dataTex(data, size, nearest) {
  const t = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

// Bilinear + wrapping, matching Heightfield.sample(). Nearest here would
// quantise 8-bit elevation into 1 m terraces and swamp the grass being tested.
const sampleField = (data, size, tx, tz) => {
  const f0 = Math.floor(tx), g0 = Math.floor(tz);
  const i0 = ((f0 % size) + size) % size, j0 = ((g0 % size) + size) % size;
  const i1 = (i0 + 1) % size, j1 = (j0 + 1) % size;
  const fx = tx - f0, fz = tz - g0;
  const a = data[j0 * size + i0] + (data[j0 * size + i1] - data[j0 * size + i0]) * fx;
  const b = data[j1 * size + i0] + (data[j1 * size + i1] - data[j1 * size + i0]) * fx;
  return a + (b - a) * fz;
};

export async function run(opts) {
  const { heightSrc, colorSrc, grassScale, camX, camZ, pitch, fov, grass } = opts;
  let yaw = opts.yaw;
  const EYE = opts.eye ?? EYE_DEFAULT;

  const [hImg, cTex] = await Promise.all([
    loadImage(heightSrc),
    new THREE.TextureLoader().loadAsync(colorSrc),
  ]);
  const size = hImg.width;
  const rgbaH = imageRgba(hImg);
  const heights = new Uint8Array(size * size);
  for (let i = 0; i < heights.length; i++) heights[i] = rgbaH[i * 4];

  cTex.flipY = false;
  cTex.colorSpace = THREE.SRGBColorSpace;
  cTex.wrapS = cTex.wrapT = THREE.RepeatWrapping;
  cTex.anisotropy = 4;

  // Sized from the COLORMAP's own dimensions. This used to pass the heightmap's
  // size, so any difference between the two images read past the end of the RGBA
  // array and silently zeroed the canopy.
  const cImg = cTex.image;
  if (cImg.width !== cImg.height) {
    throw new Error(`colormap must be square, got ${cImg.width}x${cImg.height}`);
  }
  const grassData = grassFromColormap(imageRgba(cImg), cImg.width, cImg.height);
  const grassSize = cImg.width;

  // --- terrain patch around the camera (plain grid, no LOD) ----------------
  // Terrain patch half-width. MUST exceed the grass fade distance: the march
  // samples the infinitely-wrapped heightfield, so with a small patch it finds
  // columns on terrain that was never drawn and paints grass over open sky —
  // which reads as "floating grass" along ridgelines. At 300 m against a 1100 m
  // fade that produced a 19 px fringe; at 2000 m it drops to the ~9 px of real
  // grass standing on the ridge.
  const SPAN = opts.span ?? 1400;
  // Mesh resolution is derived from the span so QUAD SIZE stays constant.
  // Raising the span with a fixed vertex count silently coarsens the mesh: at
  // span 1400 with N=220 quads become 12.7 m, too coarse to carry a ridge, so
  // the mesh dips below the true surface and sky shows through — while the grass
  // march, which samples exact heights, still draws. That reads as a floating
  // grass shelf and is worse than the artifact the larger span was fixing.
  const TARGET_QUAD = opts.quadSize ?? 4; // metres
  const N = opts.meshRes ?? Math.min(900, Math.round((SPAN * 2) / TARGET_QUAD));
  const pos = [], nor = [], uvs = [], idx = [];
  const half = (size * MPT) / 2;
  const groundAt = (x, z) => sampleField(heights, size, (x + half) / MPT, (z + half) / MPT) * HS;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = camX - SPAN + (i / N) * SPAN * 2;
      const z = camZ - SPAN + (j / N) * SPAN * 2;
      pos.push(x, groundAt(x, z), z);
      const e = MPT;
      const nx = -(groundAt(x + e, z) - groundAt(x - e, z)) / (2 * e);
      const nz = -(groundAt(x, z + e) - groundAt(x, z - e)) / (2 * e);
      const inv = 1 / Math.hypot(nx, 1, nz);
      nor.push(nx * inv, inv, nz * inv);
      uvs.push((x + half) / (size * MPT), (z + half) / (size * MPT));
    }
  }
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#9fb8cf");
  scene.fog = new THREE.Fog("#aac2d6", 300, 2200);
  scene.add(new THREE.HemisphereLight("#9fb8cf", "#5a5340", 0.75));
  const sun = new THREE.DirectionalLight("#fff4e0", 2.4);
  sun.position.set(-1000, 1440, 960);
  scene.add(sun);

  // Unlit, matching TerrainMaterial: the colormap is already pre-shaded, and if
  // the rig lights it while the app does not then the rig is measuring a different
  // picture from the one that ships.
  const terrainMat = new THREE.MeshBasicNodeMaterial();
  terrainMat.colorNode = texture(cTex, uv());
  scene.add(new THREE.Mesh(geo, terrainMat));

  if (grass) {
    const kit = createGrassMaterial({
      grassMap: dataTex(grassData, grassSize, false),
      heightMap: dataTex(heights, size, false),
      colorMap: cTex,
      worldSize: size * MPT,
      mapSize: size,
      heightScale: HS,
      grassScale,
      // Defaults track src/df2/config.ts so an un-parameterised run measures what
      // actually ships. They had drifted apart: the rig's own README documented
      // cellSize 0.03 and nearClip 1.2 while these defaults said 0.35 and 0.45.
      steps: opts.steps ?? 12,
      cellSize: opts.cellSize ?? 0.03,
      debugHit: opts.debugHit ?? false,
      debugDistance: opts.debugDistance ?? false,
      toneVariation: opts.toneVariation ?? 0.85,
      refineSteps: opts.refineSteps ?? 4,
      maxSpan: opts.maxSpan ?? 48,
      nearClip: opts.nearClip ?? 1.2,
      hashPeriod: opts.hashPeriod ?? 120,
      fadeStart: opts.fadeStart ?? 700,
      fadeEnd: opts.fadeEnd ?? 1100,
      // The rig sets its own FOV per variant, so the zoom reference must follow it
      // rather than assume the app's default.
      referenceP11: 1 / Math.tan(((fov ?? 60) * Math.PI) / 180 / 2),
    });
    const m = new THREE.Mesh(geo, kit.material);
    m.renderOrder = 1;
    scene.add(m);
  }

  // Pick a bearing where the target is NOT skylined. Aiming at a ridge puts the
  // capsule against open sky with no canopy in between, which makes concealment
  // look broken when it is only the sightline that is wrong. Score candidate
  // bearings by how level the ground is and how far the terrain along the path
  // stays below the eye-to-target line.
  function chooseBearing(dist) {
    let best = null;
    // Sweeps BEARING only, from the one camera position. At long range a single
    // spot can have no clear bearing at all, in which case sightlineVerdict below
    // reports the reading as invalid rather than the caller getting a bad number.
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      const tx = camX + Math.sin(a) * dist;
      const tz = camZ + Math.cos(a) * dist;
      const tg = groundAt(tx, tz);
      const eye = groundAt(camX, camZ) + EYE;
      const drop = Math.abs(tg - (eye - EYE));
      // How far terrain along the path pokes above the straight sightline.
      let above = 0;
      for (let i = 1; i < 24; i++) {
        const f = i / 24;
        const px = camX + (tx - camX) * f, pz = camZ + (tz - camZ) * f;
        const lineY = eye + (tg + 0.3 - eye) * f;
        above = Math.max(above, groundAt(px, pz) - lineY);
      }
      // Want: level ground, sightline clear, and grass where the target stands.
      const canopyThere = sampleField(grassData, grassSize, (tx + half) / MPT, (tz + half) / MPT) * grassScale;
      const score = drop * 1.0 + Math.max(0, above) * 4.0 - canopyThere * 12.0;
      if (!best || score < best.score) best = { score, a, tx, tz, tg, above, canopyThere };
    }
    return best;
  }

  /**
   * A concealment reading is only meaningful when the target is neither hidden
   * behind terrain nor skylined against open sky. Both produce 0 target pixels
   * or full visibility for reasons that have nothing to do with grass, and both
   * have already produced a wrong conclusion once (docs/07 §8).
   */
  function sightlineVerdict(pick) {
    if (!pick) return "no-target";
    if (pick.above > 0.5) return "TERRAIN-BLOCKED (invalid concealment test)";
    if (pick.canopyThere < 0.15) return "NO CANOPY AT TARGET (invalid)";
    return "valid";
  }

  // --- target: a capsule standing in for a player at range -----------------
  // Standing ~1.8 m upright, prone ~0.4 m lying down. This is the concealment
  // test: at range a prone target should disappear into the canopy while a
  // standing one stays visible above it.
  let targetInfo = null;
  if (opts.target) {
    const d = opts.target.distance;
    const pick = opts.target.autoBearing === false ? null : chooseBearing(d);
    if (pick) yaw = pick.a;
    const tx = pick ? pick.tx : camX + Math.sin(yaw) * d;
    const tz = pick ? pick.tz : camZ + Math.cos(yaw) * d;
    const ty = groundAt(tx, tz);
    const prone = opts.target.stance === "prone";
    // 2 m player: radius 0.28 + 1.44 cylinder = 2.00 m end to end, standing or
    // lying. Teal camo green — close enough to the canopy to be a fair test of
    // concealment rather than a high-contrast marker that would always show.
    const R = 0.28, LEN = 2.0 - 2 * R;
    const mat = new THREE.MeshBasicMaterial({ color: TARGET_COLOR });
    const mesh2 = new THREE.Mesh(new THREE.CapsuleGeometry(R, LEN, 6, 12), mat);
    if (prone) {
      // Lying along the sightline, so its silhouette is only ~0.56 m tall.
      mesh2.rotation.z = Math.PI / 2;
      mesh2.rotation.y = yaw;
      mesh2.position.set(tx, ty + R, tz);
    } else {
      mesh2.position.set(tx, ty + 1.0, tz);
    }
    scene.add(mesh2);
    targetInfo = {
      x: tx, y: ty, z: tz, prone, distance: d,
      canopyAtTarget: sampleField(grassData, grassSize, (tx + half) / MPT, (tz + half) / MPT) * grassScale,
      sightlineClearance: pick ? +pick.above.toFixed(2) : null,
      verdict: sightlineVerdict(pick),
    };
  }

  // Depth-sorting probe: a marker standing ON the ground a short way ahead. If
  // grass depth is written at the shell (a canopy-height too near) the marker is
  // wrongly occluded or wrongly in front; if written at the hit point its lower
  // part should be hidden by the columns between it and the eye.
  if (opts.probe) {
    const d = opts.probe;
    const px = camX + Math.sin(yaw) * d;
    const pz = camZ + Math.cos(yaw) * d;
    const py = groundAt(px, pz);
    const mk = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xff2266 })
    );
    mk.position.set(px, py + 0.55, pz);
    scene.add(mk);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 3.0, 10),
      new THREE.MeshBasicMaterial({ color: 0xffdd00 })
    );
    pole.position.set(px, py + 1.5, pz);
    scene.add(pole);
  }

  const canvas = document.getElementById("c");
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,
    alpha: false,
    // Needed so toDataURL sees the rendered frame.
    preserveDrawingBuffer: true,
  });
  await renderer.init();
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.setPixelRatio(1);

  const gy = groundAt(camX, camZ);
  const eyeY = gy + EYE;
  const cam = new THREE.PerspectiveCamera(fov, canvas.width / canvas.height, 0.1, 6000);
  cam.position.set(camX, eyeY, camZ);

  // Both cameras look at the target when there is one, so the scoped inset is
  // genuinely the same sightline rather than an approximation.
  const aim = new THREE.Vector3();
  if (targetInfo) {
    aim.set(targetInfo.x, targetInfo.y + (targetInfo.prone ? 0.28 : 0.9), targetInfo.z);
  } else {
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    );
    aim.set(camX + dir.x, eyeY + dir.y, camZ + dir.z);
  }
  cam.lookAt(aim);

  const scopeFov = opts.scopeFov ?? 6.5;
  const camScope = new THREE.PerspectiveCamera(scopeFov, 1, 0.1, 6000);
  camScope.position.copy(cam.position);
  camScope.lookAt(aim);

  // Draw the main view, then the scoped view into a picture-in-picture inset.
  const W = canvas.width, H = canvas.height;
  const pipSize = Math.round(Math.min(W, H) * (opts.pipScale ?? 0.42));
  const pipX = W - pipSize - 12, pipY = H - pipSize - 12;

  async function drawFrame() {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.autoClear = true;
    await renderer.renderAsync(scene, cam);

    if (opts.pip !== false) {
      // Keep the main image; draw the scope over it in its own scissor box.
      renderer.autoClear = false;
      renderer.setScissorTest(true);
      renderer.setViewport(pipX, pipY, pipSize, pipSize);
      renderer.setScissor(pipX, pipY, pipSize, pipSize);
      camScope.aspect = 1;
      camScope.updateProjectionMatrix();
      await renderer.renderAsync(scene, camScope);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
    }
  }

  await drawFrame();
  await drawFrame();
  const FRAMES = opts.frames ?? 8;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) await drawFrame();
  const msPerFrame = (performance.now() - t0) / FRAMES;

  return {
    msPerFrame,
    drawCalls: renderer.info?.render?.drawCalls ?? 0,
    triangles: renderer.info?.render?.triangles ?? 0,
    dataUrl: canvas.toDataURL("image/png"),
    backend: renderer.backend?.isWebGPUBackend ? "WebGPU" : "WebGL2",
    groundY: gy,
    target: targetInfo,
    pip: { x: pipX, y: pipY, size: pipSize },
    canopyAtCam: sampleField(grassData, grassSize, (camX + half) / MPT, (camZ + half) / MPT) * grassScale,
  };
}
