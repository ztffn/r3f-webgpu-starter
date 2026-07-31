// Animated first-person weapon rig, optionally with the PiP optic mounted to
// its real scope mesh. The player camera never moves for ADS; only this rig
// interpolates, so terrain controls and the main view remain stable.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { float, mix, positionGeometry, smoothstep, texture, uniform, vec2, vec3 } from "three/tsl";
import { CAMERA_FAR, CAMERA_NEAR } from "../df2/config";
import { publishRange, type RangeSample } from "./rangeTelemetry";

const WORLD_LAYER = 0;
const WEAPON_LAYER = 1;
const MODEL_URL = new URL("../../testmodels/fps_rig.glb", import.meta.url).href;
const RETICLE_URL = "/assets/reticles/default-mildot.png";
const MODEL_SCALE = 3;
const SCOPE_TARGET_SIZE = 512;
const SCOPE_FOV = 5.5;
const SCOPE_FOV_MIN = 2.5;
const SCOPE_FOV_MAX = 9;
const SCOPE_FOV_STEP = 0.5;
const WEAPON_FOV = 40;
const WEAPON_NEAR = 0.01;
const WEAPON_FAR = 10;
const AIM_RESPONSE = 18;
const HIP_SWAY_RADIANS = 0.012;
const AIM_SWAY_RADIANS = 0.0032;
const HIP_SWAY_METRES = 0.009;
const AIM_SWAY_METRES = 0.0018;
const HOLD_BREATH_MULTIPLIER = 0.24;
const HOLD_BREATH_RESPONSE = 14;
const EYEBOX_RADIUS_METRES = 0.02;
const EYEBOX_MAX_OFFSET = 0.32;
const FAKE_PARALLAX_STRENGTH = 0.04;
const LOOK_LAG_METRES_PER_RADIAN = 0.045;
const LOOK_LAG_MAX_METRES = 0.006;
const LOOK_LAG_RETURN = 12;
const RANGE_SAMPLE_INTERVAL_MS = 160;
const HIP_OFFSET = new THREE.Vector3(0.24, -0.37, -0.56);
// The circular lens mesh is authored in this local X/Y square. Use geometry
// coordinates for its optical screen space—the texture-atlas UV island is
// rotated relative to the physical glass.
const LENS_MIN_X = -0.010685681;
const LENS_MIN_Y = 0.08512605;
const LENS_DIAMETER = 0.02137136;

// The source exports every demonstration action as one 27-second timeline.
// These gaps are present in the key data, so split them before playback rather
// than accidentally looping a sequence of unrelated actions as "idle".
const SOURCE_FPS = 60;
// The exported animation's first usable pose is its first key at 1 / 60s;
// the glTF bind pose leaves the first-person arms outside the camera.
const INITIAL_POSE_TIME = 1 / SOURCE_FPS;
const ANIMATION_SEGMENTS = [
  [0, 1],
  [1.166667, 7.666667],
  [7.833333, 10.666667],
  [10.833333, 15],
  [15.166667, 15.833333],
  [16, 18.166666],
  [18.316668, 26.5],
  [26.666666, 27.166666],
] as const;

export interface WeaponPrototypeProps {
  /** Mount PiP display to the animated rifle's actual scope mesh. */
  scopeDemo?: boolean;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

// TSL's uniform node generic is erased when passed across a helper boundary.
// Keep it loose here; the graph is validated by the WebGPU shader compilation.
function createLensMaterial(target: THREE.RenderTarget, eyeOffset: any, reticleMap: THREE.Texture) {
  const material = new THREE.MeshBasicNodeMaterial();
  // `SCOPE_Lens` uses a rotated atlas UV island. Its raw geometry coordinates
  // describe the actual circular glass, so they keep the capture and reticle
  // aligned to the scope instead of the atlas.
  const lensUv = vec2(positionGeometry.x.sub(LENS_MIN_X), positionGeometry.y.sub(LENS_MIN_Y)).div(
    LENS_DIAMETER
  );
  const centred = lensUv.sub(vec2(0.5)).mul(2);
  // The render target is vertically inverted, while the physical lens's local
  // X axis faces the player in the opposite direction. Flip both sampling axes
  // so panning the player view left also moves the sight picture left.
  const uprightUv = vec2(float(1).sub(lensUv.x), float(1).sub(lensUv.y));
  const sampleUv = uprightUv.sub(eyeOffset.mul(FAKE_PARALLAX_STRENGTH));
  const world = texture(target.texture, sampleUv).rgb;
  const opticEdge = smoothstep(float(0.78), float(1.0), centred.length());
  const shadow = smoothstep(float(0.6), float(1.02), centred.sub(eyeOffset).length());
  // Di-Plex is an SFP reticle: sample it in physical lens coordinates, not
  // the magnified render target coordinates, so Z/X changes only the world.
  const reticle = texture(reticleMap, lensUv);
  const withReticle = mix(world, reticle.rgb, reticle.a);
  material.colorNode = mix(withReticle, vec3(0), opticEdge.max(shadow));
  material.side = THREE.DoubleSide;
  // `SCOPE_Lens` is a dedicated mesh in fps_rig.glb, so this material can take
  // part in normal depth testing against the scope body.
  material.depthTest = true;
  material.depthWrite = true;
  material.toneMapped = false;
  return material;
}

/**
 * `?scene=weapon`: show the source animation in camera space.
 * `?scene=scope`: smoothly move that same rig into ADS and capture the world
 * from its mounted optic. The supplied 27-second clip keeps playing in both.
 */
export function WeaponPrototype({ scopeDemo = false }: WeaponPrototypeProps) {
  const { camera, gl, scene, size } = useThree();
  const rig = useMemo(() => {
    const group = new THREE.Group();
    group.name = "animated-weapon-rig";
    group.layers.set(WEAPON_LAYER);
    return group;
  }, []);
  const weaponFill = useMemo(() => {
    // Deliberately kept off layer 0: the terrain keeps its authored sun/sky
    // lighting while the near-camera hands remain readable in shadow.
    const light = new THREE.AmbientLight("#c8d7ff", 0.42);
    light.name = "weapon-camera-fill";
    light.layers.set(WEAPON_LAYER);
    return light;
  }, []);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const segmentActions = useRef<THREE.AnimationAction[]>([]);
  const activeAction = useRef<THREE.AnimationAction | null>(null);
  const aiming = useRef(false);
  const holdingBreath = useRef(false);
  const breathHold = useRef(0);
  const aim = useRef(0);
  const swayTime = useRef(0);
  const cameraMotionReady = useRef(false);
  const optic = useRef<THREE.Object3D | null>(null);
  const opticLocal = useMemo(() => new THREE.Vector3(), []);
  const aimOffset = useMemo(() => new THREE.Vector3(), []);
  const hasOptic = useRef(false);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const opticWorld = useMemo(() => new THREE.Vector3(), []);
  const opticInEyeSpace = useMemo(() => new THREE.Vector3(), []);
  const lookLag = useMemo(() => new THREE.Vector2(), []);
  const previousCameraQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const cameraDeltaQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const rangeRaycaster = useMemo(() => {
    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(WORLD_LAYER);
    return raycaster;
  }, []);
  const rangeOrigin = useMemo(() => new THREE.Vector3(), []);
  const rangeDirection = useMemo(() => new THREE.Vector3(), []);
  const nextRangeSampleAt = useRef(0);
  const target = useMemo(
    () => new THREE.RenderTarget(SCOPE_TARGET_SIZE, SCOPE_TARGET_SIZE, { depthBuffer: true }),
    []
  );
  const scopeCamera = useMemo(() => {
    const result = new THREE.PerspectiveCamera(SCOPE_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    result.layers.set(WORLD_LAYER);
    return result;
  }, []);
  const scopeFov = useRef(SCOPE_FOV);
  const weaponCamera = useMemo(() => {
    const result = new THREE.PerspectiveCamera(WEAPON_FOV, 1, WEAPON_NEAR, WEAPON_FAR);
    result.layers.set(WEAPON_LAYER);
    return result;
  }, []);
  const eyeOffset = useMemo(() => uniform(new THREE.Vector2()), []);
  const reticleMap = useMemo(() => {
    const map = new THREE.TextureLoader().load(RETICLE_URL);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    return map;
  }, []);
  const lensMaterial = useMemo(
    () => createLensMaterial(target, eyeOffset, reticleMap),
    [eyeOffset, reticleMap, target]
  );

  useEffect(() => () => publishRange(null), []);

  useEffect(() => {
    const playSegment = (event: KeyboardEvent) => {
      const match = /^Digit([1-8])$/.exec(event.code);
      if (!match || event.repeat) return;
      const next = segmentActions.current[Number(match[1]) - 1];
      if (!next) return;
      // The entry action can be clamped after finishing; a clamped action must
      // be removed before an authored action takes over.
      if (activeAction.current?.paused) activeAction.current.stop();
      else activeAction.current?.fadeOut(0.1);
      next.reset();
      next.paused = false;
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      next.fadeIn(0.1).play();
      activeAction.current = next;
    };
    addEventListener("keydown", playSegment);
    return () => removeEventListener("keydown", playSegment);
  }, []);

  useEffect(() => {
    if (!scopeDemo) return;
    const toggleKeyboard = (event: KeyboardEvent) => {
      if (event.code !== "KeyR" || event.repeat) return;
      aiming.current = !aiming.current;
      if (!aiming.current) holdingBreath.current = false;
    };
    const holdBreath = (event: KeyboardEvent) => {
      if ((event.code !== "ShiftLeft" && event.code !== "ShiftRight") || !aiming.current) return;
      holdingBreath.current = event.type === "keydown";
      // While scoped, Shift belongs to breath hold rather than the fly/sprint
      // modifier. Outside ADS it remains entirely under FlyControls.
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const adjustMagnification = (event: KeyboardEvent) => {
      // Z/X retain their normal stance bindings except while looking through
      // the optic, where they are dedicated to variable magnification.
      if (!aiming.current || (event.code !== "KeyZ" && event.code !== "KeyX") || event.repeat) return;
      const direction = event.code === "KeyZ" ? -1 : 1;
      scopeFov.current = THREE.MathUtils.clamp(
        scopeFov.current + direction * SCOPE_FOV_STEP,
        SCOPE_FOV_MIN,
        SCOPE_FOV_MAX
      );
      scopeCamera.fov = scopeFov.current;
      scopeCamera.updateProjectionMatrix();
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const togglePointer = (event: PointerEvent) => {
      if (event.button !== 2) return;
      event.preventDefault();
      aiming.current = !aiming.current;
      if (!aiming.current) holdingBreath.current = false;
    };
    const preventMenu = (event: MouseEvent) => event.preventDefault();
    addEventListener("keydown", toggleKeyboard);
    addEventListener("keydown", adjustMagnification, true);
    addEventListener("keydown", holdBreath, true);
    addEventListener("keyup", holdBreath, true);
    gl.domElement.addEventListener("pointerdown", togglePointer);
    gl.domElement.addEventListener("contextmenu", preventMenu);
    return () => {
      removeEventListener("keydown", toggleKeyboard);
      removeEventListener("keydown", adjustMagnification, true);
      removeEventListener("keydown", holdBreath, true);
      removeEventListener("keyup", holdBreath, true);
      gl.domElement.removeEventListener("pointerdown", togglePointer);
      gl.domElement.removeEventListener("contextmenu", preventMenu);
    };
  }, [gl, scopeCamera, scopeDemo]);

  useEffect(() => {
    let alive = true;
    const loader = new GLTFLoader();
    loader.load(
      MODEL_URL,
      (gltf) => {
        if (!alive) {
          disposeObject(gltf.scene);
          return;
        }

        gltf.scene.scale.setScalar(MODEL_SCALE);
        // Blender exported this FPS rig facing +Z, while a Three camera looks
        // down -Z. Correct the MODEL once here (not the scope camera) so all
        // bones, the lens and ScopeCam_Target share the same forward axis.
        gltf.scene.rotation.y = Math.PI;
        gltf.scene.traverse((object) => {
          object.layers.set(WEAPON_LAYER);
          object.frustumCulled = false;
        });
        rig.add(gltf.scene);

        if (scopeDemo) {
          // The prepared rig exposes both the lens and optical camera target as
          // named objects. Do not infer either from a combined scope mesh.
          const scopeLens = gltf.scene.getObjectByName("SCOPE_Lens") as THREE.Mesh | undefined;
          const scopeCameraTarget = gltf.scene.getObjectByName("ScopeCam_Target");
          if (scopeLens?.geometry && scopeCameraTarget) {
            scopeLens.material = lensMaterial;
            scopeLens.renderOrder = 1;
            optic.current = scopeCameraTarget;

            // SCOPE_Lens is skinned: its Object3D origin remains at the rifle
            // root while only its vertices follow the weapon bones. The target
            // is bone-parented and therefore is the actual physical reference
            // point for both ADS placement and the PiP camera.
            rig.updateMatrixWorld(true);
            scopeCameraTarget.getWorldPosition(opticLocal);
            rig.worldToLocal(opticLocal);
            aimOffset.copy(opticLocal).negate().add(new THREE.Vector3(0, 0, -0.075));
            hasOptic.current = true;
          }
        }

        const nextMixer = new THREE.AnimationMixer(gltf.scene);
        const clip = gltf.animations[0];
        if (clip) {
          segmentActions.current = ANIMATION_SEGMENTS.map(([start, end], index) => {
            const segment = THREE.AnimationUtils.subclip(
              clip,
              `source-action-${index + 1}`,
              Math.round(start * SOURCE_FPS),
              Math.round(end * SOURCE_FPS),
              SOURCE_FPS
            );
            return nextMixer.clipAction(segment);
          });
          // The glTF bind pose leaves the first-person arms out of frame. Start
          // the first authored action at its first real keyed pose so the rig
          // enters in a complete, animated first-person presentation.
          const initialPose = segmentActions.current[0];
          initialPose.reset();
          initialPose.time = INITIAL_POSE_TIME;
          initialPose.setLoop(THREE.LoopOnce, 1);
          initialPose.clampWhenFinished = true;
          initialPose.play();
          nextMixer.update(0);
          activeAction.current = initialPose;
        }
        mixer.current = nextMixer;
      },
      undefined,
      (error) => console.error("Unable to load the animated weapon rig", error)
    );

    return () => {
      alive = false;
      mixer.current?.stopAllAction();
      mixer.current?.uncacheRoot(rig);
      mixer.current = null;
      segmentActions.current = [];
      activeAction.current = null;
      disposeObject(rig);
    };
  }, [aimOffset, lensMaterial, opticLocal, rig, scopeDemo]);

  useEffect(() => {
    scene.add(rig);
    scene.add(weaponFill);
    // The player camera is the world pass. Keep its layer set strict so the
    // weapon cannot leak into world DoF or the scope render target.
    camera.layers.set(WORLD_LAYER);
    // Lights must be visible to both cameras; otherwise a layer-1 weapon pass
    // would render the glTF's PBR materials black.
    scene.traverse((object) => {
      if ((object as THREE.Light).isLight) object.layers.enable(WEAPON_LAYER);
    });
    return () => {
      scene.remove(rig);
      scene.remove(weaponFill);
    };
  }, [camera, rig, scene, weaponFill]);

  useEffect(() => {
    weaponCamera.aspect = size.width / size.height;
    weaponCamera.updateProjectionMatrix();
  }, [size.height, size.width, weaponCamera]);

  // A positive priority owns the render loop. Render world (and optional scope)
  // before the near-plane weapon overlay, preserving a future single final
  // composite/grade stage instead of grading every camera independently.
  useFrame((_, delta) => {
    mixer.current?.update(delta);
    swayTime.current += delta;
    const aimTarget = scopeDemo && aiming.current && hasOptic.current ? 1 : 0;
    aim.current = THREE.MathUtils.damp(aim.current, aimTarget, AIM_RESPONSE, delta);
    const holdingScopeBreath = scopeDemo && aiming.current && holdingBreath.current;
    // Blend the transition so holding Shift never snaps the weapon or sight
    // picture to a different point in its breathing cycle.
    breathHold.current = THREE.MathUtils.damp(
      breathHold.current,
      holdingScopeBreath ? 1 : 0,
      HOLD_BREATH_RESPONSE,
      delta
    );
    const swayMultiplier = THREE.MathUtils.lerp(1, HOLD_BREATH_MULTIPLIER, breathHold.current);
    const swayRadians = THREE.MathUtils.lerp(HIP_SWAY_RADIANS, AIM_SWAY_RADIANS, aim.current) * swayMultiplier;
    const swayMetres = THREE.MathUtils.lerp(HIP_SWAY_METRES, AIM_SWAY_METRES, aim.current) * swayMultiplier;
    const swayYaw =
      (Math.sin(swayTime.current * 1.15) + Math.sin(swayTime.current * 0.41) * 0.35) * swayRadians;
    const swayPitch =
      (Math.cos(swayTime.current * 1.43) + Math.sin(swayTime.current * 0.57) * 0.25) * swayRadians * 0.72;
    const swayX = Math.sin(swayTime.current * 1.15) * swayMetres;
    const swayY = Math.cos(swayTime.current * 1.43) * swayMetres * 0.55;

    camera.updateMatrixWorld();
    // Mouse-look rotates the camera immediately, but a held rifle has a small
    // positional lag. Feed that physical lag into the eyebox rather than
    // magnifying the constant breathing motion.
    let yawDelta = 0;
    let pitchDelta = 0;
    if (cameraMotionReady.current && delta > 0) {
      cameraDeltaQuaternion.copy(previousCameraQuaternion).invert().multiply(camera.quaternion);
      // For the tiny per-frame camera deltas here, 2*x/y is the local angular
      // delta in radians. A quick look produces a one-shot weapon-lag impulse;
      // unlike a velocity target it cannot be filtered away in one frame.
      yawDelta = cameraDeltaQuaternion.y * 2;
      pitchDelta = cameraDeltaQuaternion.x * 2;
    } else {
      cameraMotionReady.current = true;
    }
    previousCameraQuaternion.copy(camera.quaternion);
    lookLag.x = THREE.MathUtils.clamp(
      lookLag.x + yawDelta * LOOK_LAG_METRES_PER_RADIAN,
      -LOOK_LAG_MAX_METRES,
      LOOK_LAG_MAX_METRES
    );
    lookLag.y = THREE.MathUtils.clamp(
      lookLag.y - pitchDelta * LOOK_LAG_METRES_PER_RADIAN,
      -LOOK_LAG_MAX_METRES,
      LOOK_LAG_MAX_METRES
    );
    lookLag.x = THREE.MathUtils.damp(lookLag.x, 0, LOOK_LAG_RETURN, delta);
    lookLag.y = THREE.MathUtils.damp(lookLag.y, 0, LOOK_LAG_RETURN, delta);
    // Query the bone-attached locator from a neutral camera-space root first.
    // This creates an up-to-date local transform after every mixer update, so
    // an animation cannot leave ADS aligned to its previous pose.
    rig.position.copy(camera.position);
    rig.quaternion.copy(camera.quaternion);
    rig.updateMatrixWorld(true);
    if (hasOptic.current && optic.current) {
      optic.current.getWorldPosition(opticLocal);
      rig.worldToLocal(opticLocal);
      aimOffset.copy(opticLocal).negate().add(new THREE.Vector3(0, 0, -0.075));
    }

    offset.copy(HIP_OFFSET);
    if (hasOptic.current) offset.lerp(aimOffset, aim.current);
    rig.translateX(offset.x + swayX + lookLag.x);
    rig.translateY(offset.y + swayY + lookLag.y);
    rig.translateZ(offset.z);
    rig.rotateY(swayYaw);
    rig.rotateX(swayPitch);
    rig.updateMatrixWorld(true);

    weaponCamera.position.copy(camera.position);
    weaponCamera.quaternion.copy(camera.quaternion);
    weaponCamera.updateMatrixWorld();

    const renderer = gl as unknown as THREE.WebGPURenderer;
    if (scopeDemo && aim.current > 0.02 && optic.current) {
      optic.current.getWorldPosition(opticWorld);
      // The eye is the player camera; the lens moves with weapon sway. Their
      // relative X/Y displacement drives both the deliberately subtle fake
      // image parallax and the asymmetric eyebox/tube occlusion.
      opticInEyeSpace.copy(opticWorld);
      camera.worldToLocal(opticInEyeSpace);
      eyeOffset.value.set(
        THREE.MathUtils.clamp(-opticInEyeSpace.x / EYEBOX_RADIUS_METRES, -EYEBOX_MAX_OFFSET, EYEBOX_MAX_OFFSET),
        THREE.MathUtils.clamp(-opticInEyeSpace.y / EYEBOX_RADIUS_METRES, -EYEBOX_MAX_OFFSET, EYEBOX_MAX_OFFSET)
      );
      scopeCamera.position.copy(opticWorld);
      // ScopeCam_Target's local rotation is an authoring-space correction, but
      // the camera-space rig rotation includes our controlled breathing sway.
      // Copy it so both the physical scope and its captured sight picture move
      // together, without inheriting the target's backwards local rotation.
      scopeCamera.quaternion.copy(rig.quaternion);
      scopeCamera.updateMatrixWorld();
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, scopeCamera);
    } else {
      eyeOffset.value.set(0, 0);
    }

    const now = performance.now();
    if (now >= nextRangeSampleAt.current) {
      nextRangeSampleAt.current = now + RANGE_SAMPLE_INTERVAL_MS;
      let range: RangeSample | null = null;
      if (scopeDemo && aim.current > 0.02) {
        // The ray starts at the player eye, but uses the scope capture camera's
        // centre direction. This reports the range the player is actually
        // aiming at, including the small optical lag/parallax currently shown.
        camera.getWorldPosition(rangeOrigin);
        scopeCamera.getWorldDirection(rangeDirection);
        rangeRaycaster.set(rangeOrigin, rangeDirection);

        const terrain = scene.getObjectByName("terrain");
        const targets = scene.getObjectByName("test-targets");
        const terrainHit = terrain ? rangeRaycaster.intersectObject(terrain, true)[0] : undefined;
        const targetHit = targets ? rangeRaycaster.intersectObject(targets, true)[0] : undefined;
        const hit = !terrainHit || (targetHit && targetHit.distance < terrainHit.distance) ? targetHit : terrainHit;
        if (hit) {
          range = {
            metres: hit.distance,
            kind: hit === targetHit ? "target" : "terrain",
          };
        }
      }
      publishRange(range);
    }

    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    renderer.render(scene, camera);
    // The overlay must not inherit the world's depth buffer or its close weapon
    // fragments would be rejected by terrain/grass depth already in the canvas.
    // A color Scene.background is special: Three force-clears it even when
    // autoClear is false. Hide it just for this weapon-only pass so the world
    // color buffer remains underneath the gun.
    const worldBackground = scene.background;
    renderer.autoClear = false;
    scene.background = null;
    renderer.clearDepth();
    renderer.render(scene, weaponCamera);
    scene.background = worldBackground;
    renderer.autoClear = true;
  }, 1);

  useEffect(
    () => () => {
      target.dispose();
      lensMaterial.dispose();
      reticleMap.dispose();
    },
    [lensMaterial, reticleMap, target]
  );

  return null;
}
