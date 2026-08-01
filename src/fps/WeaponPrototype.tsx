// Animated first-person weapon rig, optionally with the PiP optic mounted to
// its real scope mesh. The player camera never moves for ADS; only this rig
// interpolates, so terrain controls and the main view remain stable.

import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { float, mix, positionGeometry, smoothstep, texture, uniform, vec2, vec3 } from "three/tsl";
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR } from "../df2/config";
import { publishRange, type RangeSample } from "./rangeTelemetry";
import { LocalPlayerController, type LocalPlayerCommands } from "./core/LocalPlayerController";
import type { PlayerStance } from "./core/PlayerMotor";
import type { RegisteredWorldQuery } from "./core/WorldQuery";
import { BallisticProjectileSystem, type BallisticResult } from "./combat/BallisticProjectileSystem";
import { readBallisticEnvironment } from "./combat/BallisticEnvironment";
import { LoadoutSystem } from "./weapons/LoadoutSystem";
import { WeaponSystem, type WeaponEvent } from "./weapons/WeaponSystem";
import { SNIPER_DEFINITION } from "./weapons/weaponDefinitions";
import { ammunitionFromSearch } from "./weapons/AmmunitionDefinition";
import { combatTelemetry } from "./ui/CombatTelemetry";
import { shotDebugStore } from "./debug/ShotDebugStore";
import { impactEffectBus } from "./presentation/ImpactEffectBus";
import { FPS_DEBUG } from "./debug/debugConfig";
import {
  AIM_DIAGNOSTIC_RANGE_METRES,
  type LookSensitivityController,
} from "./core/LookSensitivityController";
import { AimSwayController } from "./core/AimSwayController";
import {
  ScopeAdjustmentController,
  scopeAdjustmentActionForKey,
  type ScopeAdjustmentSnapshot,
} from "./core/ScopeAdjustmentController";

const WORLD_LAYER = 0;
const WEAPON_LAYER = 1;
const MODEL_URL = new URL("../../testmodels/fps_rig.glb", import.meta.url).href;
const RETICLE_URL = "/assets/reticles/default-mildot.png";
const MODEL_SCALE = 3;
const SCOPE_TARGET_SIZE = 512;
const SCOPE_STATUS_SIZE = 512;
const SCOPE_FOV = 5.5;
const SCOPE_FOV_MIN = 2.5;
const SCOPE_FOV_MAX = 9;
const SCOPE_FOV_STEP = 0.5;
const WEAPON_FOV = 40;
const WEAPON_NEAR = 0.01;
const WEAPON_FAR = 10;
const AIM_RESPONSE = 18;
const EYEBOX_RADIUS_METRES = 0.02;
const EYEBOX_MAX_OFFSET = 0.32;
const FAKE_PARALLAX_STRENGTH = 0.04;
const LOOK_LAG_METRES_PER_RADIAN = 0.045;
const LOOK_LAG_MAX_METRES = 0.006;
const LOOK_LAG_RETURN = 12;
const RANGE_SAMPLE_INTERVAL_MS = 160;
const PERFORMANCE_SAMPLE_SECONDS = 0.25;
const HIP_OFFSET = new THREE.Vector3(0.24, -0.37, -0.56);
const OPTIC_EYE_OFFSET = new THREE.Vector3(0, 0, -0.075);
const LOCAL_X = new THREE.Vector3(1, 0, 0);
const LOCAL_Y = new THREE.Vector3(0, 1, 0);
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
  worldQuery: RegisteredWorldQuery;
  stance?: PlayerStance;
  grounded?: boolean;
  lookSensitivity: LookSensitivityController;
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
function drawScopeStatus(textureMap: THREE.CanvasTexture, snapshot: ScopeAdjustmentSnapshot) {
  const canvas = textureMap.image as HTMLCanvasElement;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.textBaseline = "middle";
  context.textAlign = "right";
  context.fillStyle = "rgba(7, 8, 7, 0.88)";
  context.fillText(`ZERO ${snapshot.zeroDistanceMetres} M`, 390, 350);
  const windage = snapshot.windageMilliradians;
  const windageLabel =
    windage === 0
      ? "WIND 0.0"
      : `WIND ${windage < 0 ? "L" : "R"} ${Math.abs(windage).toFixed(1)}`;
  context.fillText(windageLabel, 390, 368);
  textureMap.needsUpdate = true;
}

function createScopeStatusTexture(snapshot: ScopeAdjustmentSnapshot): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = SCOPE_STATUS_SIZE;
  canvas.height = SCOPE_STATUS_SIZE;
  const textureMap = new THREE.CanvasTexture(canvas);
  textureMap.flipY = false;
  textureMap.colorSpace = THREE.SRGBColorSpace;
  textureMap.generateMipmaps = false;
  textureMap.minFilter = THREE.LinearFilter;
  textureMap.magFilter = THREE.LinearFilter;
  drawScopeStatus(textureMap, snapshot);
  return textureMap;
}

function createLensMaterial(
  target: THREE.RenderTarget,
  eyeOffset: any,
  scopeActive: any,
  reticleMap: THREE.Texture,
  scopeStatusMap: THREE.Texture
) {
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
  const scopeStatus = texture(scopeStatusMap, uprightUv);
  const withScopeStatus = mix(withReticle, scopeStatus.rgb, scopeStatus.a);
  const activeDisplay = mix(withScopeStatus, vec3(0), opticEdge.max(shadow));

  // Hip-fire never updates the PiP target, so do not show its old frame on the
  // visible glass. This is deliberately a coated-glass approximation rather
  // than a dynamic reflection capture: it costs a few ALU ops on one small
  // lens and stays plausible across different terrain colours.
  const glassTint = mix(vec3(0.008, 0.018, 0.019), vec3(0.028, 0.075, 0.078), lensUv.y);
  const sheenDirection = centred.x.mul(-0.65).add(centred.y.mul(0.45));
  const sheen = smoothstep(float(-0.5), float(0.72), sheenDirection);
  const rim = smoothstep(float(0.34), float(0.96), centred.length());
  const hipGlass = mix(glassTint, vec3(0.15, 0.28, 0.3), sheen.mul(0.24).add(rim.mul(0.13)));
  const hipDisplay = mix(hipGlass, vec3(0), opticEdge);

  material.colorNode = mix(hipDisplay, activeDisplay, scopeActive);
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
export function WeaponPrototype({
  scopeDemo = false,
  worldQuery,
  stance = "stand",
  grounded = false,
  lookSensitivity,
}: WeaponPrototypeProps) {
  const { camera, gl, scene, size } = useThree();
  const player = useMemo(() => new LocalPlayerController(), []);
  const ammunition = useMemo(
    () => ammunitionFromSearch(typeof window === "undefined" ? "" : window.location.search),
    []
  );
  const weaponDefinition = useMemo(
    () => ({
      ...SNIPER_DEFINITION,
      displayName:
        ammunition.id === "308"
          ? SNIPER_DEFINITION.displayName
          : `${SNIPER_DEFINITION.displayName} · ${ammunition.displayName} test`,
      shot: {
        ...SNIPER_DEFINITION.shot,
        damage: ammunition.baseDamage,
        ammunition,
      },
    }),
    [ammunition]
  );
  const weapon = useMemo(() => new WeaponSystem(weaponDefinition), [weaponDefinition]);
  const loadout = useMemo(
    () => new LoadoutSystem([{ id: "primary", weapon }], "primary"),
    [weapon]
  );
  const ballisticEnvironment = useMemo(
    () => readBallisticEnvironment(typeof window === "undefined" ? "" : window.location.search),
    []
  );
  const captureShotTrace = FPS_DEBUG.shotTrajectory;
  const ballistics = useMemo(
    () => new BallisticProjectileSystem(worldQuery, ballisticEnvironment),
    [ballisticEnvironment, worldQuery]
  );
  const ballisticPerformance = useMemo(
    () => ({
      elapsedSeconds: 0,
      simulationMilliseconds: 0,
      maxSimulationMilliseconds: 0,
      frames: 0,
      segmentQueries: 0,
      terrainCellTests: 0,
      colliderCandidates: 0,
    }),
    [ballistics, worldQuery]
  );
  const scopeAdjustments = useMemo(
    () =>
      new ScopeAdjustmentController(
        {
          muzzleVelocityMetresPerSecond: ammunition.muzzleVelocityMetresPerSecond,
          ballisticCoefficientG1: ammunition.ballisticCoefficientG1,
        },
        ballisticEnvironment,
        weaponDefinition.shot.maxFlightSeconds
      ),
    [ammunition, ballisticEnvironment, weaponDefinition.shot.maxFlightSeconds]
  );
  const commands = useMemo<LocalPlayerCommands>(
    () => ({ triggerPresses: 0, reloadRequested: false, adsWanted: false, holdingBreath: false }),
    []
  );
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
  const aim = useRef(0);
  const aimSway = useMemo(() => new AimSwayController(), []);
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
  const rangeOrigin = useMemo(() => new THREE.Vector3(), []);
  const rangeDirection = useMemo(() => new THREE.Vector3(), []);
  const authoritativeDirection = useMemo(() => new THREE.Vector3(), []);
  const boreDirection = useMemo(() => new THREE.Vector3(), []);
  const authoritativeAimQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const aimYawQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const aimPitchQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const playerPose = useMemo(
    () => ({ position: camera.position, stance, grounded }),
    [camera]
  );
  const recoilPitch = useRef(0);
  const recoilYaw = useRef(0);
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
  const scopeActive = useMemo(() => uniform(0), []);
  const reticleMap = useMemo(() => {
    const map = new THREE.TextureLoader().load(RETICLE_URL);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    return map;
  }, []);
  const scopeStatusMap = useMemo(
    () => createScopeStatusTexture(scopeAdjustments.getSnapshot()),
    [scopeAdjustments]
  );
  const lensMaterial = useMemo(
    () => createLensMaterial(target, eyeOffset, scopeActive, reticleMap, scopeStatusMap),
    [eyeOffset, reticleMap, scopeActive, scopeStatusMap, target]
  );

  const playSegment = useCallback((segmentNumber: number) => {
    const next = segmentActions.current[segmentNumber - 1];
    if (!next) return;
    // A clamped action must be stopped before another authored action takes over.
    if (activeAction.current?.paused) activeAction.current.stop();
    else activeAction.current?.fadeOut(0.1);
    next.reset();
    next.paused = false;
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
    next.fadeIn(0.1).play();
    activeAction.current = next;
  }, []);

  const handleWeaponEvent = useCallback(
    (event: WeaponEvent) => {
      if (event.type === "shot") {
        const spawned = ballistics.spawn({
          sourceId: weaponDefinition.id,
          sequence: event.sequence,
          origin: player.aim.origin,
          direction: boreDirection,
          sightDirection: player.aim.direction,
          maxDistance: event.range,
          maxFlightSeconds: event.maxFlightSeconds,
          damage: event.damage,
          ammunition: event.ammunition,
          captureTrace: captureShotTrace,
        });
        if (!spawned) combatTelemetry.publishProjectileRejected();
        recoilPitch.current += event.recoilPitch;
        recoilYaw.current += event.sequence % 2 === 0 ? -event.recoilYaw : event.recoilYaw;
        if (event.animationSegment !== undefined) playSegment(event.animationSegment);
        return;
      }
      if (event.type === "dry-fire") {
        combatTelemetry.publishDryFire();
        if (event.animationSegment !== undefined) playSegment(event.animationSegment);
        return;
      }
      if (event.type === "reload-started" && event.animationSegment !== undefined) {
        playSegment(event.animationSegment);
      }
    },
    [ballistics, boreDirection, captureShotTrace, playSegment, player, weaponDefinition]
  );

  const handleBallisticResult = useCallback((result: BallisticResult) => {
    combatTelemetry.publishShot(result);
    shotDebugStore.publish(result.trace);
  }, []);

  const handleImpact = useCallback((event: Parameters<typeof impactEffectBus.publish>[0]) => {
    combatTelemetry.publishImpact(event);
    impactEffectBus.publish(event);
  }, []);

  useEffect(
    () => () => {
      publishRange(null);
      combatTelemetry.clear();
      shotDebugStore.clear();
      lookSensitivity.reset();
      aimSway.reset();
      ballistics.clear();
    },
    [aimSway, ballistics, lookSensitivity]
  );

  useEffect(() => {
    combatTelemetry.publishBallisticEnvironment(ballisticEnvironment);
  }, [ballisticEnvironment]);

  useEffect(() => {
    const publish = () => {
      const snapshot = scopeAdjustments.getSnapshot();
      drawScopeStatus(scopeStatusMap, snapshot);
      combatTelemetry.publishScopeAdjustment(snapshot);
    };
    publish();
    return scopeAdjustments.subscribe(publish);
  }, [scopeAdjustments, scopeStatusMap]);

  useEffect(() => {
    const playDebugSegment = (event: KeyboardEvent) => {
      const match = /^Digit([1-8])$/.exec(event.code);
      if (!match || event.repeat) return;
      playSegment(Number(match[1]));
    };
    addEventListener("keydown", playDebugSegment);
    return () => removeEventListener("keydown", playDebugSegment);
  }, [playSegment]);

  useEffect(() => {
    if (!scopeDemo) return;
    const requestReload = (event: KeyboardEvent) => {
      if (event.code !== "KeyR" || event.repeat) return;
      player.setAdsWanted(false);
      player.requestReload();
    };
    const holdBreath = (event: KeyboardEvent) => {
      if ((event.code !== "ShiftLeft" && event.code !== "ShiftRight") || !player.wantsAds) return;
      player.setHoldingBreath(event.type === "keydown");
      // While scoped, Shift belongs to breath hold rather than the fly/sprint
      // modifier. Outside ADS it remains entirely under FlyControls.
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const adjustMagnification = (event: KeyboardEvent) => {
      // Z/X retain their normal stance bindings except while looking through
      // the optic, where they are dedicated to variable magnification.
      if (!player.wantsAds || (event.code !== "KeyZ" && event.code !== "KeyX") || event.repeat) return;
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
    const adjustTurrets = (event: KeyboardEvent) => {
      const action = scopeAdjustmentActionForKey(event);
      if (
        !action ||
        !player.wantsAds ||
        document.pointerLockElement !== gl.domElement
      ) {
        return;
      }
      // Consume matching keydown even when held, but apply one exact click only
      // on the initial press. Keyup is deliberately not intercepted so the
      // movement controller can always clear an earlier arrow-key press.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) scopeAdjustments.apply(action);
    };
    const togglePointer = (event: PointerEvent) => {
      // The browser requires a user gesture before pointer lock. Do not also
      // turn that first capture click into an accidental shot.
      if (event.button === 0 && document.pointerLockElement === gl.domElement) {
        player.pressTrigger();
      }
      if (event.button === 2) {
        event.preventDefault();
        player.toggleAds();
      }
    };
    const clearInput = () => player.resetInput();
    const preventMenu = (event: MouseEvent) => event.preventDefault();
    addEventListener("keydown", requestReload);
    addEventListener("keydown", adjustMagnification, true);
    addEventListener("keydown", adjustTurrets, true);
    addEventListener("keydown", holdBreath, true);
    addEventListener("keyup", holdBreath, true);
    addEventListener("blur", clearInput);
    gl.domElement.addEventListener("pointerdown", togglePointer);
    gl.domElement.addEventListener("contextmenu", preventMenu);
    return () => {
      removeEventListener("keydown", requestReload);
      removeEventListener("keydown", adjustMagnification, true);
      removeEventListener("keydown", adjustTurrets, true);
      removeEventListener("keydown", holdBreath, true);
      removeEventListener("keyup", holdBreath, true);
      removeEventListener("blur", clearInput);
      gl.domElement.removeEventListener("pointerdown", togglePointer);
      gl.domElement.removeEventListener("contextmenu", preventMenu);
    };
  }, [gl, player, scopeAdjustments, scopeCamera, scopeDemo]);

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
    // Existing rounds advance before this frame's input can spawn another one,
    // so a newly accepted shot never receives time that elapsed before firing.
    const ballisticStartedAt = performance.now();
    ballistics.update(delta);
    const ballisticMilliseconds = performance.now() - ballisticStartedAt;
    ballisticPerformance.elapsedSeconds += delta;
    ballisticPerformance.simulationMilliseconds += ballisticMilliseconds;
    ballisticPerformance.maxSimulationMilliseconds = Math.max(
      ballisticPerformance.maxSimulationMilliseconds,
      ballisticMilliseconds
    );
    ballisticPerformance.frames += 1;
    if (ballisticPerformance.elapsedSeconds >= PERFORMANCE_SAMPLE_SECONDS) {
      const projectileMetrics = ballistics.getMetrics();
      const queryMetrics = worldQuery.getMetrics();
      const elapsed = ballisticPerformance.elapsedSeconds;
      combatTelemetry.publishProjectilePerformance({
        activeProjectiles: projectileMetrics.active,
        peakActiveProjectiles: projectileMetrics.peakActive,
        simulationMillisecondsPerFrame:
          ballisticPerformance.simulationMilliseconds / ballisticPerformance.frames,
        maxSimulationMilliseconds: ballisticPerformance.maxSimulationMilliseconds,
        segmentQueriesPerSecond:
          (projectileMetrics.segmentQueries - ballisticPerformance.segmentQueries) / elapsed,
        terrainCellTestsPerSecond:
          (queryMetrics.terrainCellTests - ballisticPerformance.terrainCellTests) / elapsed,
        colliderCandidatesPerSecond:
          (queryMetrics.colliderCandidates - ballisticPerformance.colliderCandidates) / elapsed,
        expiredProjectiles: projectileMetrics.expiredProjectiles,
      });
      ballisticPerformance.elapsedSeconds = 0;
      ballisticPerformance.simulationMilliseconds = 0;
      ballisticPerformance.maxSimulationMilliseconds = 0;
      ballisticPerformance.frames = 0;
      ballisticPerformance.segmentQueries = projectileMetrics.segmentQueries;
      ballisticPerformance.terrainCellTests = queryMetrics.terrainCellTests;
      ballisticPerformance.colliderCandidates = queryMetrics.colliderCandidates;
    }
    ballistics.drainImpactEvents(handleImpact);
    ballistics.drainResults(handleBallisticResult);

    camera.updateMatrixWorld();
    playerPose.stance = stance;
    playerPose.grounded = grounded;
    player.consumeCommands(commands);
    weapon.setAdsWanted(commands.adsWanted);
    if (commands.reloadRequested) weapon.requestReload();
    for (let i = 0; i < commands.triggerPresses; i += 1) weapon.pressTrigger();
    loadout.update(delta);
    const aimTarget = scopeDemo && hasOptic.current ? weapon.adsProgress : 0;
    aim.current = THREE.MathUtils.damp(aim.current, aimTarget, AIM_RESPONSE, delta);
    const holdingScopeBreath = scopeDemo && commands.holdingBreath;
    aimSway.update(delta, {
      stance,
      adsBlend: aim.current,
      holdingBreath: holdingScopeBreath,
  });
    if (scopeDemo) {
      lookSensitivity.setOpticState(
        aim.current,
        aimSway.breathStabilization,
        CAMERA_FOV,
        scopeFov.current
      );
    } else lookSensitivity.reset();
    combatTelemetry.publishAimDiagnostics(
      lookSensitivity.centimetresPerCountAt(AIM_DIAGNOSTIC_RANGE_METRES),
      AIM_DIAGNOSTIC_RANGE_METRES,
      Math.tan(aimSway.angularAmplitudeRadians) * AIM_DIAGNOSTIC_RANGE_METRES,
      aimSway.breathStabilization,
      stance
    );

    authoritativeAimQuaternion.copy(camera.quaternion);
    aimYawQuaternion.setFromAxisAngle(LOCAL_Y, aimSway.yawRadians);
    aimPitchQuaternion.setFromAxisAngle(LOCAL_X, aimSway.pitchRadians);
    authoritativeAimQuaternion.multiply(aimYawQuaternion).multiply(aimPitchQuaternion);
    authoritativeDirection.set(0, 0, -1).applyQuaternion(authoritativeAimQuaternion).normalize();
    scopeAdjustments.applyToSightDirection(authoritativeDirection, boreDirection);
    player.syncPresentationPose(playerPose, authoritativeDirection);
    // Shot events are drained only after the exact swayed aim shown this frame
    // has become authoritative gameplay state.
    loadout.drainEvents(handleWeaponEvent);
    combatTelemetry.publishWeapon(weapon.getSnapshot());

    mixer.current?.update(delta);
    scopeActive.value = scopeDemo ? aim.current : 0;

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
      aimOffset.copy(opticLocal).negate().add(OPTIC_EYE_OFFSET);
    }

    offset.copy(HIP_OFFSET);
    if (hasOptic.current) offset.lerp(aimOffset, aim.current);
    rig.translateX(offset.x + aimSway.positionXMetres + lookLag.x);
    rig.translateY(offset.y + aimSway.positionYMetres + lookLag.y);
    rig.translateZ(offset.z);
    recoilPitch.current = THREE.MathUtils.damp(recoilPitch.current, 0, 8, delta);
    recoilYaw.current = THREE.MathUtils.damp(recoilYaw.current, 0, 10, delta);
    rig.rotateY(aimSway.yawRadians + recoilYaw.current);
    rig.rotateX(aimSway.pitchRadians + recoilPitch.current);
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
      // Scope picture, rangefinder, shot resolver and trajectory debug all use
      // the same authoritative aim, including stance/breath gameplay sway.
      scopeCamera.quaternion.copy(authoritativeAimQuaternion);
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
        // centre direction. Its orientation is the same authoritative direction
        // used by ballistic spawn; only its origin retains the tiny physical optic offset.
        camera.getWorldPosition(rangeOrigin);
        scopeCamera.getWorldDirection(rangeDirection);
        const hit = worldQuery.raycast(rangeOrigin, rangeDirection, CAMERA_FAR);
        if (hit) {
          range = {
            metres: hit.distance,
            kind: hit.kind,
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
      scopeStatusMap.dispose();
    },
    [lensMaterial, reticleMap, scopeStatusMap, target]
  );

  return null;
}
