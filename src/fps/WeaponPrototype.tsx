// Animated first-person weapon rig, optionally with the PiP optic mounted to
// its real scope mesh. The player camera never moves for ADS; only this rig
// interpolates, so terrain controls and the main view remain stable.

import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { type LoadoutEvent } from "./weapons/LoadoutSystem";
import {
  GLOCK_DEFINITION,
  M4_DEFINITION,
  SAW_DEFINITION,
  SNIPER_DEFINITION,
} from "./weapons/weaponDefinitions";
import { createDevelopmentLoadout, LOCAL_PLAYER_SEED } from "./weapons/developmentLoadout";
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
import { WeaponAimComposer } from "./core/WeaponAimComposer";
import {
  clampSimulationDelta,
  createFiringTimelineFrame,
  FiringTimeline,
  type AcceptedShotView,
} from "./core/FiringTimeline";
import {
  ScopeAdjustmentController,
  scopeAdjustmentActionForKey,
  type ScopeAdjustmentSnapshot,
} from "./core/ScopeAdjustmentController";
import { weaponPresentationFor } from "./presentation/WeaponPresentationDefinition";
import { weaponAimIndicator } from "./ui/WeaponAimIndicator";

const WORLD_LAYER = 0;
const WEAPON_LAYER = 1;
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
const MAX_TRANSITIONAL_SPEED_METRES_PER_SECOND = 30;
// The circular lens mesh is authored in this local X/Y square. Use geometry
// coordinates for its optical screen space—the texture-atlas UV island is
// rotated relative to the physical glass.
const LENS_MIN_X = -0.010685681;
const LENS_MIN_Y = 0.08512605;
const LENS_DIAMETER = 0.02137136;

export interface WeaponPrototypeProps {
  /** Mount PiP display to the animated rifle's actual scope mesh. */
  scopeDemo?: boolean;
  worldQuery: RegisteredWorldQuery;
  stance?: PlayerStance;
  grounded?: boolean;
  lookSensitivity: LookSensitivityController;
}

function collectTextures(material: THREE.Material, into: Set<THREE.Texture>) {
  for (const value of Object.values(material)) {
    if (value && (value as THREE.Texture).isTexture) into.add(value as THREE.Texture);
  }
}

/**
 * Releases the GPU resources a loaded rig owns. Three.js material disposal does
 * not touch referenced textures, and both materials and geometries can be
 * shared between meshes, so each is collected once and disposed once.
 * `preservedMaterial` is created and disposed by this component; neither it nor
 * its textures belong to the rig. `replacedMaterials` are rig materials that
 * were swapped out at load time and would otherwise never be reachable again.
 */
function disposeObject(
  root: THREE.Object3D,
  preservedMaterial?: THREE.Material,
  replacedMaterials: readonly THREE.Material[] = []
) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>(replacedMaterials);
  // A skinned mesh owns a bone-matrix DataTexture that only Skeleton.dispose()
  // releases; nothing reachable from geometry or material frees it.
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.isSkinnedMesh && mesh.skeleton) skeletons.add(mesh.skeleton);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const item of material) if (item) materials.add(item);
    } else if (material) materials.add(material);
  });
  if (preservedMaterial) materials.delete(preservedMaterial);

  const preservedTextures = new Set<THREE.Texture>();
  if (preservedMaterial) collectTextures(preservedMaterial, preservedTextures);
  const textures = new Set<THREE.Texture>();
  for (const material of materials) {
    collectTextures(material, textures);
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const texture of textures) {
    if (!preservedTextures.has(texture)) texture.dispose();
  }
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
  const sniperDefinition = useMemo(
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
  const loadout = useMemo(
    () => createDevelopmentLoadout(LOCAL_PLAYER_SEED, sniperDefinition),
    [sniperDefinition]
  );
  const [presentationWeaponId, setPresentationWeaponId] = useState(sniperDefinition.id);
  const presentation = weaponPresentationFor(presentationWeaponId);
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
    () => {
      const controllers = new Map<string, ScopeAdjustmentController>();
      for (const definition of [
        sniperDefinition,
        M4_DEFINITION,
        GLOCK_DEFINITION,
        SAW_DEFINITION,
      ]) {
        const shot = definition.shot;
        controllers.set(
          definition.id,
          new ScopeAdjustmentController(
            {
              muzzleVelocityMetresPerSecond: shot.ammunition.muzzleVelocityMetresPerSecond,
              ballisticCoefficientG1: shot.ammunition.ballisticCoefficientG1,
            },
            ballisticEnvironment,
            shot.maxFlightSeconds
          )
        );
      }
      return controllers;
    },
    [ballisticEnvironment, sniperDefinition]
  );
  const activeScopeAdjustments = useRef(scopeAdjustments.get(sniperDefinition.id)!);
  const commands = useMemo<LocalPlayerCommands>(
    () => ({ weaponCommands: [], adsWanted: false, holdingBreath: false }),
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
  const crosshairPoint = useMemo(() => new THREE.Vector3(), []);
  const authoritativeDirection = useMemo(() => new THREE.Vector3(), []);
  const aimComposer = useMemo(() => new WeaponAimComposer(), []);
  const authoritativeAimQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const currentMeanAimQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const timelineFrame = useMemo(() => createFiringTimelineFrame(), []);
  const simulationStartPosition = useMemo(() => new THREE.Vector3(), []);
  const simulationStartQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const simulationPoseReady = useRef(false);
  const firingTimeline = useMemo(
    () =>
      new FiringTimeline({
        ballistics,
        sway: aimSway,
        // Resolved from the accepted round's own weapon so a switch inside the
        // frame cannot apply another optic's zero.
        sightAdjustmentFor: (weaponId) =>
          scopeAdjustments.get(weaponId) ?? activeScopeAdjustments.current,
      }),
    [aimSway, ballistics, scopeAdjustments]
  );
  const playerPose = useMemo(
    () => ({ position: camera.position, stance, grounded, planarSpeedMetresPerSecond: 0 }),
    [camera]
  );
  const handlingContext = useMemo(
    () => ({
      stance,
      grounded,
      planarSpeedMetresPerSecond: 0,
      breathStabilization: 0,
    }),
    []
  );
  const previousPlayerPosition = useMemo(() => new THREE.Vector3(), []);
  const playerMotionReady = useRef(false);
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
    () => createScopeStatusTexture(activeScopeAdjustments.current.getSnapshot()),
    []
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

  const handleAcceptedShot = useCallback(
    (shot: AcceptedShotView, event: Extract<LoadoutEvent, { type: "shot" }>) => {
      if (!shot.spawned) combatTelemetry.publishProjectileRejected();
      recoilPitch.current += event.recoilImpulsePitchRadians;
      recoilYaw.current += event.recoilImpulseYawRadians;
      const segment = weaponPresentationFor(event.weaponId).animationSegments.fire;
      if (segment !== undefined) playSegment(segment);
    },
    [playSegment]
  );

  const handleWeaponEvent = useCallback(
    (event: Exclude<LoadoutEvent, { type: "shot" }>) => {
      if (event.type === "dry-fire") {
        combatTelemetry.publishDryFire();
        const segment = weaponPresentationFor(event.weaponId).animationSegments.dryFire;
        if (segment !== undefined) playSegment(segment);
        return;
      }
      if (event.type === "reload-started") {
        const segment = weaponPresentationFor(event.weaponId).animationSegments.reload;
        if (segment !== undefined) playSegment(segment);
        return;
      }
      if (event.type === "weapon-switch-started") {
        const idle = weaponPresentationFor(loadout.equippedWeapon.definition.id).animationSegments.idle;
        if (idle !== undefined) playSegment(idle);
        return;
      }
      if (event.type === "weapon-equipped") {
        setPresentationWeaponId(event.weaponId);
      }
    },
    [loadout, playSegment]
  );

  // `runFrame` takes its handlers per call, so this needs no stable identity.
  const timelineHandlers = { onShot: handleAcceptedShot, onEvent: handleWeaponEvent };

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
      weaponAimIndicator.clear();
    },
    [aimSway, ballistics, lookSensitivity]
  );

  useEffect(() => {
    combatTelemetry.publishBallisticEnvironment(ballisticEnvironment);
  }, [ballisticEnvironment]);

  useEffect(() => {
    const publish = () => {
      const snapshot = activeScopeAdjustments.current.getSnapshot();
      drawScopeStatus(scopeStatusMap, snapshot);
      combatTelemetry.publishScopeAdjustment(snapshot);
    };
    publish();
    const unsubscribes = [...scopeAdjustments.values()].map((controller) =>
      controller.subscribe(() => {
        if (controller === activeScopeAdjustments.current) publish();
      })
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [scopeAdjustments, scopeStatusMap]);

  useEffect(() => {
    if (!FPS_DEBUG.weaponAnimations || scopeDemo) return;
    const playDebugSegment = (event: KeyboardEvent) => {
      const match = /^Digit([1-8])$/.exec(event.code);
      if (!match || event.repeat) return;
      playSegment(Number(match[1]));
    };
    addEventListener("keydown", playDebugSegment);
    return () => removeEventListener("keydown", playDebugSegment);
  }, [playSegment, scopeDemo]);

  useEffect(() => {
    if (!scopeDemo) return;
    const handleWeaponKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.code === "KeyR") {
        player.setAdsWanted(false);
        player.requestReload();
        return;
      }
      if (event.code === "KeyB") {
        player.selectFireMode();
        return;
      }
      const equipMatch = /^Digit([1-4])$/.exec(event.code);
      if (equipMatch) {
        player.setAdsWanted(false);
        player.equipSlot(Number(equipMatch[1]));
      }
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
      if (!event.repeat) activeScopeAdjustments.current.apply(action);
    };
    const handlePointerDown = (event: PointerEvent) => {
      // The browser requires a user gesture before pointer lock. Do not also
      // turn that first capture click into an accidental shot.
      if (event.button === 0 && document.pointerLockElement === gl.domElement) {
        player.triggerDown();
      }
      if (event.button === 2) {
        event.preventDefault();
        player.toggleAds();
      }
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.button === 0) player.triggerUp();
    };
    const clearInput = () => {
      player.resetInput();
      loadout.clearHeldTrigger();
    };
    const handlePointerLockChange = () => {
      if (document.pointerLockElement !== gl.domElement) clearInput();
    };
    const preventMenu = (event: MouseEvent) => event.preventDefault();
    addEventListener("keydown", handleWeaponKey);
    addEventListener("keydown", adjustMagnification, true);
    addEventListener("keydown", adjustTurrets, true);
    addEventListener("keydown", holdBreath, true);
    addEventListener("keyup", holdBreath, true);
    addEventListener("blur", clearInput);
    addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointerlockchange", handlePointerLockChange);
    gl.domElement.addEventListener("pointerdown", handlePointerDown);
    gl.domElement.addEventListener("contextmenu", preventMenu);
    return () => {
      removeEventListener("keydown", handleWeaponKey);
      removeEventListener("keydown", adjustMagnification, true);
      removeEventListener("keydown", adjustTurrets, true);
      removeEventListener("keydown", holdBreath, true);
      removeEventListener("keyup", holdBreath, true);
      removeEventListener("blur", clearInput);
      removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointerlockchange", handlePointerLockChange);
      gl.domElement.removeEventListener("pointerdown", handlePointerDown);
      gl.domElement.removeEventListener("contextmenu", preventMenu);
      clearInput();
      loadout.deactivateAll();
    };
  }, [gl, loadout, player, scopeCamera, scopeDemo]);

  useEffect(() => {
    let alive = true;
    optic.current = null;
    hasOptic.current = false;
    // Materials this component swaps out of the loaded rig. Nothing else can
    // reach them afterwards, so teardown owns their disposal.
    const replacedMaterials: THREE.Material[] = [];
    // The mixer is built on the loaded scene, not on the host group, and
    // uncacheRoot silently does nothing when handed the wrong root.
    let mixerRoot: THREE.Object3D | null = null;
    const loader = new GLTFLoader();
    loader.load(
      presentation.modelUrl,
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
            const authoredLensMaterial = scopeLens.material;
            if (Array.isArray(authoredLensMaterial)) {
              replacedMaterials.push(...authoredLensMaterial);
            } else if (authoredLensMaterial) replacedMaterials.push(authoredLensMaterial);
            scopeLens.material = lensMaterial;
            scopeLens.renderOrder = 1;
            optic.current = scopeCameraTarget;

            // SCOPE_Lens is skinned: its Object3D origin remains at the rifle
            // root while only its vertices follow the weapon bones. The target
            // is bone-parented and therefore is the actual physical reference
            // point for both ADS placement and the PiP camera.
            // The frame loop recomputes aimOffset from this locator immediately
            // before every use, so a load-time copy would be dead state.
            hasOptic.current = true;
          }
        }

        const nextMixer = new THREE.AnimationMixer(gltf.scene);
        mixerRoot = gltf.scene;
        const clip = gltf.animations[0];
        const sourceAnimation = presentation.sourceAnimation;
        if (clip && sourceAnimation) {
          segmentActions.current = sourceAnimation.segmentsSeconds.map(([start, end], index) => {
            const segment = THREE.AnimationUtils.subclip(
              clip,
              `source-action-${index + 1}`,
              Math.round(start * sourceAnimation.framesPerSecond),
              Math.round(end * sourceAnimation.framesPerSecond),
              sourceAnimation.framesPerSecond
            );
            return nextMixer.clipAction(segment);
          });
          // The glTF bind pose leaves the first-person arms out of frame. Start
          // the first authored action at its first real keyed pose so the rig
          // enters in a complete, animated first-person presentation.
          const initialPose = segmentActions.current[0];
          initialPose.reset();
          initialPose.time = sourceAnimation.initialPoseSeconds;
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
      if (mixerRoot) mixer.current?.uncacheRoot(mixerRoot);
      mixer.current = null;
      mixerRoot = null;
      segmentActions.current = [];
      activeAction.current = null;
      optic.current = null;
      hasOptic.current = false;
      disposeObject(rig, lensMaterial, replacedMaterials);
      replacedMaterials.length = 0;
      rig.clear();
    };
  }, [lensMaterial, presentation, rig, scopeDemo]);

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
    // Weapons, gameplay sway, and projectiles share one clamped clock. A hitch
    // must not hand the three systems different amounts of simulation time.
    const simulationDelta = clampSimulationDelta(delta);
    camera.updateMatrixWorld();
    playerPose.stance = stance;
    playerPose.grounded = grounded;
    if (playerMotionReady.current && delta > 0) {
      playerPose.planarSpeedMetresPerSecond = Math.min(
        MAX_TRANSITIONAL_SPEED_METRES_PER_SECOND,
        Math.hypot(
          camera.position.x - previousPlayerPosition.x,
          camera.position.z - previousPlayerPosition.z
        ) / delta
      );
    } else {
      playerPose.planarSpeedMetresPerSecond = 0;
      playerMotionReady.current = true;
    }
    previousPlayerPosition.copy(camera.position);
    player.syncMotorPose(playerPose);
    handlingContext.stance = player.stance;
    handlingContext.grounded = player.grounded;
    handlingContext.planarSpeedMetresPerSecond = player.planarSpeedMetresPerSecond;
    handlingContext.breathStabilization = aimSway.breathStabilization;
    loadout.setHandlingContext(handlingContext);
    player.consumeCommands(commands);
    for (const command of commands.weaponCommands) loadout.handleCommand(command);
    loadout.setAdsWanted(commands.adsWanted);
    const adsProgressBefore = loadout.equippedWeapon.adsProgress;
    loadout.update(simulationDelta);
    const equippedWeapon = loadout.equippedWeapon;
    const weaponSnapshot = equippedWeapon.getSnapshot();
    const nextScopeAdjustments = scopeAdjustments.get(equippedWeapon.definition.id)!;
    if (activeScopeAdjustments.current !== nextScopeAdjustments) {
      activeScopeAdjustments.current = nextScopeAdjustments;
      const scopeSnapshot = nextScopeAdjustments.getSnapshot();
      drawScopeStatus(scopeStatusMap, scopeSnapshot);
      combatTelemetry.publishScopeAdjustment(scopeSnapshot);
    }

    if (!simulationPoseReady.current) {
      simulationStartPosition.copy(camera.position);
      simulationStartQuaternion.copy(camera.quaternion);
      simulationPoseReady.current = true;
    }
    timelineFrame.deltaSeconds = simulationDelta;
    timelineFrame.startPosition.copy(simulationStartPosition);
    timelineFrame.endPosition.copy(camera.position);
    timelineFrame.startOrientation.copy(simulationStartQuaternion);
    timelineFrame.endOrientation.copy(camera.quaternion);
    timelineFrame.stance = stance;
    timelineFrame.holdingBreath = scopeDemo && commands.holdingBreath;
    timelineFrame.swayHandlingMultiplier = weaponSnapshot.swayFactor;
    // Gameplay sway follows authoritative ADS progress, not the damped rig
    // blend: sway must not depend on whether the proxy GLTF finished loading.
    timelineFrame.adsProgressStart = adsProgressBefore;
    timelineFrame.adsProgressEnd = equippedWeapon.adsProgress;
    timelineFrame.captureTrace = captureShotTrace;
    // Sway advance, per-boundary shot spawning, and projectile stepping all
    // happen inside this call, in cadence order on one timeline.
    const simulationStartedAt = performance.now();
    firingTimeline.runFrame(timelineFrame, loadout, timelineHandlers);
    const simulationMilliseconds = performance.now() - simulationStartedAt;
    simulationStartPosition.copy(camera.position);
    simulationStartQuaternion.copy(camera.quaternion);

    ballisticPerformance.elapsedSeconds += delta;
    ballisticPerformance.simulationMilliseconds += simulationMilliseconds;
    ballisticPerformance.maxSimulationMilliseconds = Math.max(
      ballisticPerformance.maxSimulationMilliseconds,
      simulationMilliseconds
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

    const aimTarget = scopeDemo && hasOptic.current ? equippedWeapon.adsProgress : 0;
    aim.current = THREE.MathUtils.damp(aim.current, aimTarget, AIM_RESPONSE, delta);
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

    aimComposer.composeQuaternion(
      camera.quaternion,
      aimSway.yawRadians,
      aimSway.pitchRadians,
      authoritativeAimQuaternion
    );
    aimComposer.composeQuaternion(
      authoritativeAimQuaternion,
      weaponSnapshot.recoilYawRadians,
      weaponSnapshot.recoilPitchRadians,
      currentMeanAimQuaternion
    );
    aimComposer.directionFromQuaternion(currentMeanAimQuaternion, authoritativeDirection);
    player.syncAim(authoritativeDirection);
    crosshairPoint.copy(camera.position).add(authoritativeDirection).project(camera);
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    const coneRadiusPixels =
      (Math.tan(weaponSnapshot.dispersionConeRadians) /
        Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.fov) * 0.5)) *
      size.height *
      0.5;
    weaponAimIndicator.publish(
      (crosshairPoint.x * 0.5 + 0.5) * size.width,
      (-crosshairPoint.y * 0.5 + 0.5) * size.height,
      coneRadiusPixels,
      1 - THREE.MathUtils.smoothstep(aim.current, 0.15, 0.75),
      scopeDemo &&
        FPS_DEBUG.hipfireCrosshair &&
        document.pointerLockElement === gl.domElement &&
        crosshairPoint.z >= -1 &&
        crosshairPoint.z <= 1
    );
    combatTelemetry.publishWeapon(weaponSnapshot);

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
    rig.rotateY(aimSway.yawRadians + weaponSnapshot.recoilYawRadians + recoilYaw.current);
    rig.rotateX(aimSway.pitchRadians + weaponSnapshot.recoilPitchRadians + recoilPitch.current);
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
      scopeCamera.quaternion.copy(currentMeanAimQuaternion);
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
