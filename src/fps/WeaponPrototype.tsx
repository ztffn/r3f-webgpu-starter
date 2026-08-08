// Animated first-person weapon rig, optionally with the PiP optic mounted to
// its real scope mesh. The player camera never moves for ADS; only this rig
// interpolates, so terrain controls and the main view remain stable.

import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { float, mix, positionGeometry, smoothstep, texture, uniform, vec2, vec3 } from "three/tsl";
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR } from "../df2/config";
import { publishRange, type RangeSample } from "./rangeTelemetry";
import { LocalPlayerController, type LocalPlayerCommands } from "./core/LocalPlayerController";
import type {
  PlayerStance,
  PlayerMotorSnapshotTarget,
  PlayerWeaponIntent,
} from "./core/PlayerMotor";
import { lookAngles } from "../motor/MotorTypes";
import type { RegisteredWorldQuery } from "./core/WorldQuery";
import { BallisticProjectileSystem, type BallisticResult } from "../combat/BallisticProjectileSystem.ts";
import {
  DEFAULT_BALLISTIC_ENVIRONMENT,
  readBallisticEnvironment,
} from "../combat/BallisticEnvironment.ts";
import { type LoadoutEvent } from "./weapons/LoadoutSystem";
import {
  GLOCK_DEFINITION,
  M4_DEFINITION,
  SAW_DEFINITION,
  SNIPER_DEFINITION,
  weaponWireIndex,
} from "../combat/weaponDefinitions.ts";
import { createDevelopmentLoadout, LOCAL_PLAYER_SEED } from "./weapons/developmentLoadout";
import {
  ammunitionFromSearch,
  DEFAULT_AMMUNITION,
} from "../combat/AmmunitionDefinition.ts";
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
import {
  presentationForRigKey,
  weaponPresentationFor,
  type RigWeaponKey,
} from "./presentation/WeaponPresentationDefinition";
import { FirstPersonWeaponRig } from "./presentation/FirstPersonWeaponRig.ts";
import { loadHands, loadWeapon, assertHandClips } from "./presentation/fpRigAssets.ts";
import { weaponPoses } from "./presentation/weaponPoseStore.ts";
import { WeaponBobController } from "./presentation/WeaponBob.ts";
import {
  createWeaponRigPlacementFrame,
  WeaponRigPlacement,
} from "./presentation/WeaponRigPlacement.ts";
import { weaponAimIndicator } from "./ui/WeaponAimIndicator";

const WORLD_LAYER = 0;
const WEAPON_LAYER = 1;
const RETICLE_URL = "/assets/reticles/default-mildot.png";
const SCOPE_TARGET_SIZE = 512;
const SCOPE_STATUS_SIZE = 512;
const SCOPE_FOV = 5.5;
const SCOPE_FOV_MIN = 2.5;
const SCOPE_FOV_MAX = 9;
const SCOPE_FOV_STEP = 0.5;
const WEAPON_FOV = 40;
const WEAPON_NEAR = 0.01;
const WEAPON_FAR = 10;
/**
 * How tightly the rig's visual ADS blend follows the weapon's authoritative progress,
 * expressed in damping time-constants per second of that weapon's own ADS duration.
 *
 * It is a RATIO, not a rate, and that is the fix. A single global rate — this was 18, a
 * fixed ~56 ms lag — is applied identically to every weapon, so it smears the authored
 * per-weapon timings into each other: the M4 enters in 0.14 s and the sniper in 0.22 s,
 * a difference of 80 ms, and a shared 56 ms tail on both leaves them feeling the same
 * kind of soft. Scaling the rate to the weapon keeps the lag a fixed FRACTION of its own
 * ADS time, so a fast weapon is visibly fast and the authored numbers are what you feel.
 *
 * 4 is ANCHORED, not chosen for snappiness: it reproduces the old flat 18 at the sniper's
 * 0.22 s, so the slowest scoped weapon feels exactly as it did and the change is purely
 * the per-weapon SPREAD it was hiding. Faster weapons get faster and the LMG, at 0.24 s,
 * gets slightly slower — which is the point. Raising this speeds up every weapon at once,
 * which is a different decision and should be made deliberately.
 */
const AIM_RESPONSE_PER_ADS_SECOND = 4;

/** Below this the derived rate would be absurd; no authored ADS time is near it. */
const MIN_ADS_SECONDS = 0.05;
const EYEBOX_RADIUS_METRES = 0.02;
const EYEBOX_MAX_OFFSET = 0.32;
const FAKE_PARALLAX_STRENGTH = 0.04;
const LOOK_LAG_METRES_PER_RADIAN = 0.02;
const LOOK_LAG_MAX_METRES = 0.08;
/** ln2 / 0.14 s — Source's own look-lag half-life, where the weight actually comes from. */
const LOOK_LAG_RETURN = 4.95;
const RANGE_SAMPLE_INTERVAL_MS = 160;
const PERFORMANCE_SAMPLE_SECONDS = 0.25;
// Hip and ADS placement are PER WEAPON and live in `weaponPoseStore`, tunable from the
// dev console's Weapon pose tab. The authored models differ enough that one offset cannot
// serve them all, and the proxy's single pair was tuned against a 3x-scaled model with a
// different internal origin — carried over unchanged it put the hands below the frame.
const MAX_TRANSITIONAL_SPEED_METRES_PER_SECOND = 30;
/**
 * How fast the rig blends into and out of the sprint pose.
 *
 * Deliberately quicker than any ADS blend: dropping out of a sprint is the moment before
 * the player wants to shoot, and a slow return would read as the weapon being sticky.
 * Provisional — the sprint animation pass has reference values to check this against.
 */
const SPRINT_BLEND_RESPONSE = 12;

/**
 * The authored hands face +Z while a Three camera looks down -Z.
 *
 * Applied to the hands root once, so every bone, the attached weapon and its lens all
 * share one forward axis. There is no scale term any more: the proxy needed 3x, while
 * the authored armature already carries Blender's 0.01 unit conversion and arrives in
 * metres.
 */
const RIG_YAW = Math.PI;

/**
 * Debug-only bindings for the rig weapons no gameplay definition maps to.
 *
 * Pressing the same key again clears the override and returns to the equipped weapon's own
 * model, so there is always a way back without cycling through the whole set.
 *
 * `Digit0` is ALSO the scope zero/windage reset, and the two do not collide: the turret
 * handler runs on the capture phase and stops propagation only while aiming and pointer
 * locked, so 0 resets the zero while scoped and reaches the knife otherwise. Deliberate,
 * because six weapons need six keys and 0 is the only one left.
 */
const DEBUG_RIG_KEYS: readonly { code: string; key: RigWeaponKey }[] = [
  { code: "Digit5", key: "ak" },
  { code: "Digit6", key: "smg" },
  { code: "Digit7", key: "shotgun" },
  { code: "Digit8", key: "fiftycal" },
  { code: "Digit9", key: "grenadelauncher" },
  { code: "Digit0", key: "knife" },
];
export interface WeaponPrototypeProps {
  /** Mount PiP display to the animated rifle's actual scope mesh. */
  scopeDemo?: boolean;
  worldQuery: RegisteredWorldQuery;
  stance?: PlayerStance;
  grounded?: boolean;
  lookSensitivity: LookSensitivityController;
  /**
   * Authoritative player state from a real character motor, published earlier
   * this frame. When present it REPLACES the `stance` and `grounded` props and
   * the camera-differentiated speed — see the frame body for why grounded in
   * particular cannot be inferred without it.
   */
  motorPose?: PlayerMotorSnapshotTarget | null;
  /**
   * Published each frame so the motor can slow the player while aiming. This
   * host stays the owner of ADS; only the intent crosses over.
   */
  weaponIntent?: PlayerWeaponIntent | null;
  /**
   * Called for every accepted shot with the direction the round actually left
   * along, so a networked host can claim the shot to the server.
   *
   * INTENT ONLY, and it changes nothing locally: impact effects, tracers and the
   * client's own ballistic simulation are unchanged presentation. This is the one
   * thing that makes another player's health fall, and the server decides whether
   * it did (docs/12 §8.3).
   */
  onShotFired?: ((yawRadians: number, pitchRadians: number) => void) | null;
  /**
   * Called when a weapon switch completes, with the weapon's wire index, and
   * when a reload starts. Same contract as `onShotFired`: claims to the
   * authority, changing nothing locally. The server re-times both with its own
   * switch and reload clocks — these exist so its loadout record tracks what
   * the player is actually holding.
   */
  onWeaponSelected?: ((weaponIndex: number) => void) | null;
  onReloadStarted?: (() => void) | null;
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
  lensFrame: any,
  reticleMap: THREE.Texture,
  scopeStatusMap: THREE.Texture
) {
  const material = new THREE.MeshBasicNodeMaterial();
  // Optical screen space comes from the glass's own GEOMETRY, never its UVs — an
  // authored lens maps its atlas island at whatever rotation the artist found
  // convenient, and the proxy's was rotated relative to the physical glass.
  //
  // The frame is a uniform rather than three baked constants because the rig now ships
  // more than one optic: the sniper's glass is a flat 17-vertex disc and the carbine's
  // is a slightly domed 33-vertex plane, measured at different sizes. `lensFrame` is
  // (centre.x, centre.y, radius) in lens-local space, published when a weapon is
  // equipped. Both authored lenses are flat on local Z, so X/Y is the screen plane.
  const lensMin = lensFrame.xy.sub(lensFrame.z);
  const lensUv = positionGeometry.xy.sub(lensMin).div(lensFrame.z.mul(2));
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
  // Every authored optic keeps its glass as a dedicated mesh under the scope body, so
  // this material can take part in normal depth testing rather than being sorted around.
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
  motorPose = null,
  weaponIntent = null,
  onShotFired = null,
  onWeaponSelected = null,
  onReloadStarted = null,
}: WeaponPrototypeProps) {
  const { camera, gl, scene, size } = useThree();
  const player = useMemo(() => new LocalPlayerController(), []);
  // NETWORKED MEANS AUTHORED. The server scores damage with the canonical
  // definitions, so the `?ammo=` sniper experiment is an offline toy — honoring
  // it online would show the shooter one arc while the room scores another.
  // Same rule as `?weather=` (docs/12 §8.1).
  const networked = onShotFired !== null;
  const ammunition = useMemo(
    () =>
      networked
        ? DEFAULT_AMMUNITION
        : ammunitionFromSearch(typeof window === "undefined" ? "" : window.location.search),
    [networked]
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
  /**
   * A rig weapon shown INSTEAD of the equipped weapon's own, or null.
   *
   * Six of the ten rig weapons have no gameplay definition, so nothing can equip them and
   * they cannot be posed or inspected. This puts one on screen without touching gameplay:
   * ammunition, cadence and the ballistics all remain those of whatever is really equipped,
   * so firing on a debug model is the equipped weapon firing behind a different mesh.
   */
  const [presentationOverride, setPresentationOverride] = useState<RigWeaponKey | null>(null);
  // Memoised because `presentationForRigKey` builds a fresh object each call and this is
  // a dependency of the asset-load-and-equip effect: unmemoised, any re-render of this
  // component re-equipped the weapon from scratch and replayed its raise on screen. The
  // normal path was safe by luck — `weaponPresentationFor` returns stable table entries.
  const presentation = useMemo(
    () =>
      presentationOverride
        ? presentationForRigKey(presentationOverride)
        : weaponPresentationFor(presentationWeaponId),
    [presentationOverride, presentationWeaponId]
  );
  // URL wind overrides are offline toys for the same reason as `?ammo=`: the
  // server integrates far shots with the default environment, and wind that
  // differs between shooter and authority is drift the shooter cannot hold for.
  const ballisticEnvironment = useMemo(
    () =>
      networked
        ? DEFAULT_BALLISTIC_ENVIRONMENT
        : readBallisticEnvironment(typeof window === "undefined" ? "" : window.location.search),
    [networked]
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
      projectileMilliseconds: 0,
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
  /** Owns both mixers, the wrist attach, the muzzle flash and the optic anchor. */
  const weaponRig = useRef<FirstPersonWeaponRig | null>(null);
  const aim = useRef(0);
  /** 0 at the hip, 1 fully in the sprint pose. Damped like `aim`. */
  const sprintBlend = useRef(0);
  /** The frame's single sprint truth, resolved once and read by pose and gameplay alike. */
  const sprinting = useRef(false);
  /** Movement bob. The CAMERA never bobs — only this rig does (WeaponBob.ts). */
  const weaponBob = useMemo(() => new WeaponBobController(), []);
  const aimSway = useMemo(() => new AimSwayController(), []);
  const hasOptic = useRef(false);
  /** Where the rig sits: authored pose, ADS alignment, and the additive layers on top. */
  const placement = useMemo(() => new WeaponRigPlacement(), []);
  const placementFrame = useMemo(() => createWeaponRigPlacementFrame(), []);
  const opticWorld = useMemo(() => new THREE.Vector3(), []);
  const opticInEyeSpace = useMemo(() => new THREE.Vector3(), []);
  const lookLag = useMemo(() => new THREE.Vector2(), []);
  const cameraDeltaQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const rangeOrigin = useMemo(() => new THREE.Vector3(), []);
  const rangeDirection = useMemo(() => new THREE.Vector3(), []);
  const crosshairPoint = useMemo(() => new THREE.Vector3(), []);
  const authoritativeDirection = useMemo(() => new THREE.Vector3(), []);
  const aimComposer = useMemo(() => new WeaponAimComposer(), []);
  const authoritativeAimQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const currentMeanAimQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const timelineFrame = useMemo(() => createFiringTimelineFrame(), []);
  // The previous frame's end pose, and this frame's start pose. One capture
  // feeds planar speed, sub-frame interpolation, and the weapon-lag impulse.
  const framePreviousPosition = useMemo(() => new THREE.Vector3(), []);
  const framePreviousQuaternion = useMemo(() => new THREE.Quaternion(), []);
  /** Where rounds actually leave from this frame. See the frame body. */
  const shotOrigin = useMemo(() => new THREE.Vector3(), []);
  const framePoseReady = useRef(false);
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
  // `position` is reassigned each frame to the resolved shot origin, so it must
  // not alias the camera — see `shotOrigin`.
  const playerPose = useMemo(
    () => ({
      position: new THREE.Vector3(),
      stance,
      grounded,
      planarSpeedMetresPerSecond: 0,
    }),
    []
  );
  const handlingContext = useMemo(
    () => ({
      stance,
      grounded,
      sprinting: false,
      planarSpeedMetresPerSecond: 0,
      breathStabilization: 0,
    }),
    []
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
  /** (centre.x, centre.y, radius) of the equipped weapon's glass, in lens-local space. */
  const lensFrame = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);
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
    () => createLensMaterial(target, eyeOffset, scopeActive, lensFrame, reticleMap, scopeStatusMap),
    [eyeOffset, lensFrame, reticleMap, scopeActive, scopeStatusMap, target]
  );

  /**
   * Play one authored segment on both mixers.
   *
   * Takes the clip NAME. The proxy addressed segments as numbers because it was one long
   * timeline sliced by frame range; the authored rig ships each segment as its own glTF
   * animation, so the indirection has no remaining purpose. An undefined segment means
   * the rig authored no clip for that event and nothing should play.
   */
  const playSegment = useCallback((segment: string | undefined) => {
    if (segment !== undefined) weaponRig.current?.play(segment);
  }, []);

  const handleAcceptedShot = useCallback(
    (shot: AcceptedShotView, event: Extract<LoadoutEvent, { type: "shot" }>) => {
      if (!shot.spawned) combatTelemetry.publishProjectileRejected();
      recoilPitch.current += event.recoilImpulsePitchRadians;
      recoilYaw.current += event.recoilImpulseYawRadians;
      playSegment(presentation.segments.fire);
      // Every weapon except the knife ships its own flash mesh, positioned per calibre.
      weaponRig.current?.triggerMuzzleFlash();
      // The PROJECTILE direction, not the sight direction: the round is what can
      // hit somebody, and the two differ by the dispersion the server does not
      // simulate — which is exactly the deviation its clamp is sized for.
      if (onShotFired) {
        const angles = lookAngles(
          shot.projectileDirection.x,
          shot.projectileDirection.y,
          shot.projectileDirection.z
        );
        onShotFired(angles.yawRadians, angles.pitchRadians);
      }
    },
    [onShotFired, playSegment, presentation]
  );

  const handleWeaponEvent = useCallback(
    (event: Exclude<LoadoutEvent, { type: "shot" }>) => {
      if (event.type === "dry-fire") {
        combatTelemetry.publishDryFire();
        // The authored rig has NO dry-fire clip. Playing the reload or a shoot here
        // would show the player an action they did not take, so this stays silent
        // until one is authored; the HUD still reports the dry fire.
        playSegment(presentation.segments.dryFire);
        return;
      }
      if (event.type === "reload-started") {
        playSegment(presentation.segments.reload);
        onReloadStarted?.();
        return;
      }
      if (event.type === "weapon-switch-started") {
        // The outgoing weapon lowers; the incoming one raises when it is equipped.
        playSegment(presentation.segments.holster);
        return;
      }
      if (event.type === "weapon-equipped") {
        setPresentationWeaponId(event.weaponId);
        if (onWeaponSelected) {
          const wireIndex = weaponWireIndex(event.weaponId);
          if (wireIndex !== null) onWeaponSelected(wireIndex);
        }
      }
    },
    [onReloadStarted, onWeaponSelected, playSegment, presentation]
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
    // Digits inspect the equipped weapon's own segments, in the order the presentation
    // declares them. The proxy's 1–8 addressed slices of a single timeline; these
    // address named clips, so the set differs per weapon and a weapon with fewer
    // segments simply has fewer live keys.
    const playDebugSegment = (event: KeyboardEvent) => {
      const match = /^Digit([1-9])$/.exec(event.code);
      if (!match || event.repeat) return;
      const segments = Object.values(presentation.segments);
      const segment = segments[Number(match[1]) - 1];
      if (segment !== undefined) playSegment(segment);
    };
    addEventListener("keydown", playDebugSegment);
    return () => removeEventListener("keydown", playDebugSegment);
  }, [playSegment, presentation, scopeDemo]);

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
        // A real equip drops the debug model, so the two cannot disagree about what is held.
        setPresentationOverride(null);
        player.equipSlot(Number(equipMatch[1]));
        return;
      }
      // 5-0 show the six rig weapons no gameplay definition maps to. Six weapons need six
      // keys, which is why this reaches past 9 to 0 — and 5 is free, since fire mode is B.
      const debugKey = DEBUG_RIG_KEYS.find((entry) => entry.code === event.code);
      if (debugKey) {
        player.setAdsWanted(false);
        setPresentationOverride((was) => (was === debugKey.key ? null : debugKey.key));
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
      // Comma and period, NOT Z/X and NOT brackets.
      //
      // Z and X were fine while a camera rig owned stance; with a real motor
      // mounted they collide outright, since aiming and pressing Z zoomed the
      // optic AND dropped the player prone. Stance wins that argument.
      //
      // Brackets were the first fix and were worse in a quieter way: `event.code`
      // is PHYSICAL position, so `BracketLeft` is whatever key sits right of P —
      // labelled `Å` on a Norwegian keyboard, not `[`. A control documented as
      // one key and pressed as another is a trap. Comma and period carry the
      // same label on US and Nordic layouts, so the docs and the keycap agree.
      if (
        !player.wantsAds ||
        (event.code !== "Comma" && event.code !== "Period") ||
        event.repeat
      ) {
        return;
      }
      const direction = event.code === "Comma" ? -1 : 1;
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
    hasOptic.current = false;
    // The authored lens material is swapped for the picture-in-picture one while this
    // scene owns the weapon, and has to be put back. Weapon assets are cached for the
    // session, so a lens left holding the scope material would carry it into the next
    // mount — including `?scene=weapon`, which has no render target feeding it.
    let restoreLens: (() => void) | null = null;

    const renderer = gl as unknown as THREE.WebGPURenderer;
    Promise.all([loadHands(renderer), loadWeapon(renderer, presentation)])
      .then(([hands, weapon]) => {
        if (!alive) return;
        assertHandClips(hands, presentation);

        let rigInstance = weaponRig.current;
        if (!rigInstance) {
          rigInstance = new FirstPersonWeaponRig(hands);
          weaponRig.current = rigInstance;
          // Correct the HANDS once, so every bone, the attached weapon and its lens
          // share one forward axis — the same reasoning the proxy used, minus its scale.
          rigInstance.root.rotation.y = RIG_YAW;
          rig.add(rigInstance.root);
        }
        rigInstance.equip(weapon, presentation);

        // Applied after the equip so the newly attached weapon is included. Frustum
        // culling stays off: the rig renders in camera space, nowhere near the bounds
        // computed from its bind pose.
        rig.traverse((object) => {
          object.layers.set(WEAPON_LAYER);
          object.frustumCulled = false;
        });

        const optic = rigInstance.optic;
        if (scopeDemo && optic) {
          // EVERY mesh of the glass, not just the first. A lens authored with two
          // material slots arrives as a Group of primitives, and swapping one of them
          // would leave the rest showing the authored material over half the sight
          // picture — the muzzle flash's bug in a place that is harder to notice.
          const authored = optic.meshes.map((mesh) => mesh.material);
          for (const mesh of optic.meshes) {
            mesh.material = lensMaterial;
            mesh.renderOrder = 1;
          }
          restoreLens = () => {
            optic.meshes.forEach((mesh, index) => {
              mesh.material = authored[index];
            });
          };
          // The shader reads the glass's own geometry, so tell it where that glass is.
          lensFrame.value.set(optic.centre.x, optic.centre.y, optic.radius);
          if (optic.axis !== "z") {
            // Both authored lenses are flat on local Z, and the shader treats X/Y as the
            // optical screen plane. One flat on another axis would sample the sight
            // picture edge-on, which looks like a broken scope rather than a bad guess.
            console.error(
              `[fp-rig] ${presentation.rigKey} lens "${optic.lens.name}" is flat on ` +
                `${optic.axis}, not z — the scope picture is mapped on the wrong axes`
            );
          }
          hasOptic.current = true;
        }
        // Published so the pose tab tunes what is actually on screen, and labels the ADS
        // dials as eye relief or as a placeholder raise depending on what resolved.
        weaponPoses.equipped = presentation.rigKey;
        weaponPoses.equippedHasOptic = hasOptic.current;
      })
      .catch((error) => console.error("Unable to load the first-person weapon rig", error));

    return () => {
      alive = false;
      restoreLens?.();
      restoreLens = null;
      hasOptic.current = false;
    };
  }, [gl, lensFrame, lensMaterial, presentation, rig, scopeDemo]);

  // The rig outlives individual weapon swaps, so its teardown is separate from the
  // per-weapon effect above. It detaches without disposing: fpRigAssets caches the
  // hands and every equipped weapon for the session, and a remount reuses those very
  // objects, so freeing their geometry here would break the second mount.
  useEffect(
    () => () => {
      weaponRig.current?.dispose();
      weaponRig.current = null;
      rig.clear();
    },
    [rig]
  );

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

    // The frame's start pose is captured exactly once, here, while the previous
    // frame's end pose is still intact. Planar speed, the timeline's sub-frame
    // interpolation, and the weapon-lag impulse all read this one capture, so
    // no future camera work inside this callback can make them disagree.
    // Rounds leave the player's EYE, which is not always where the camera is.
    // A third-person camera sits metres behind the body, so spawning from the
    // camera puts the muzzle behind the player and every shot starts in the
    // wrong place. The motor's eye is authoritative whenever it exists; the
    // camera is only a stand-in for it.
    shotOrigin.copy(motorPose !== null ? motorPose.position : camera.position);

    // The pose tab's two held states, refused online.
    //
    // Gated for CONSISTENCY with the ADS-timing override, not for the same reason, and
    // the difference is worth keeping straight. That override is refused online because
    // the SERVER scores with the authored durations, so a shooter running different
    // numbers would see an arc the room does not — the `?ammo=` rule (docs/12 §8.1).
    // These two change nothing the server scores: holding sprint only makes your own
    // client refuse to fire, and holding ADS only aims a model. Do not read this gate as
    // evidence that the timing gate was mere tidiness.
    const heldAds = !networked && weaponPoses.forceAds;
    const heldSprint = !networked && weaponPoses.forceSprint;

    const hadPreviousFrame = framePoseReady.current;
    let yawDelta = 0;
    let pitchDelta = 0;
    if (hadPreviousFrame && delta > 0) {
      playerPose.planarSpeedMetresPerSecond = Math.min(
        MAX_TRANSITIONAL_SPEED_METRES_PER_SECOND,
        Math.hypot(
          shotOrigin.x - framePreviousPosition.x,
          shotOrigin.z - framePreviousPosition.z
        ) / delta
      );
      cameraDeltaQuaternion.copy(framePreviousQuaternion).invert().multiply(camera.quaternion);
      // For the tiny per-frame camera deltas here, 2*x/y is the local angular
      // delta in radians.
      yawDelta = cameraDeltaQuaternion.y * 2;
      pitchDelta = cameraDeltaQuaternion.x * 2;
    } else {
      playerPose.planarSpeedMetresPerSecond = 0;
    }
    timelineFrame.startPosition.copy(hadPreviousFrame ? framePreviousPosition : shotOrigin);
    timelineFrame.startOrientation.copy(
      hadPreviousFrame ? framePreviousQuaternion : camera.quaternion
    );
    framePreviousPosition.copy(shotOrigin);
    framePreviousQuaternion.copy(camera.quaternion);
    framePoseReady.current = true;

    if (motorPose !== null) {
      // A real motor knows things the camera cannot express. `grounded`
      // especially: differentiating camera position cannot tell you the player
      // is airborne, so without this it stays true through a jump and
      // `airborneDispersionRadians` never applies. Speed comes from the motor's
      // own velocity rather than a differentiated position, which also drops
      // the frame-rate-dependent noise in that estimate.
      playerPose.stance = motorPose.stance;
      playerPose.grounded = motorPose.grounded;
      playerPose.planarSpeedMetresPerSecond = Math.min(
        MAX_TRANSITIONAL_SPEED_METRES_PER_SECOND,
        motorPose.planarSpeedMetresPerSecond
      );
    } else {
      playerPose.stance = stance;
      playerPose.grounded = grounded;
    }
    playerPose.position.copy(shotOrigin);
    player.syncMotorPose(playerPose);
    // Includes the held aim so the motor's aiming slowdown cannot disagree with the
    // weapon about whether the player is aiming — one held state, read the same way in
    // both places, for the same reason `sprinting` below is resolved exactly once.
    if (weaponIntent !== null) weaponIntent.aiming = player.wantsAds || heldAds;
    handlingContext.stance = player.stance;
    handlingContext.grounded = player.grounded;
    // Only a real motor can report this; without one there is no sprint state
    // to block on, and the weapon behaves as it always did.
    // ONE sprint state, read by BOTH the pose blend and the weapon's refusal to fire.
    // Having two produced exactly the contradiction it sounds like: a weapon posed
    // mid-sprint that would still shoot, because the visual condition and the gameplay
    // condition were different expressions that disagreed.
    //
    // No speed fallback. An earlier version treated "moving faster than 4.5 m/s" as
    // sprinting so the pose would work without a motor, which conflates RUNNING with
    // SPRINTING — the one distinction this pose exists to draw — and free-fly crosses that
    // threshold constantly. Sprint is a state a player enters, so it needs a real one:
    // the motor's, or the dev console holding it.
    sprinting.current = heldSprint || (motorPose !== null && motorPose.sprinting);
    handlingContext.sprinting = sprinting.current;
    handlingContext.planarSpeedMetresPerSecond = player.planarSpeedMetresPerSecond;
    handlingContext.breathStabilization = aimSway.breathStabilization;
    loadout.setHandlingContext(handlingContext);
    player.consumeCommands(commands);
    for (const command of commands.weaponCommands) loadout.handleCommand(command);
    // The pose tab can hold ADS so the aimed placement is tunable while the pointer is on
    // a slider — releasing pointer lock to reach the console otherwise drops the aim.
    loadout.setAdsWanted(commands.adsWanted || heldAds);
    const weaponBeforeUpdate = loadout.equippedWeapon;
    const adsProgressBefore = weaponBeforeUpdate.adsProgress;
    loadout.update(simulationDelta);
    const equippedWeapon = loadout.equippedWeapon;
    const weaponSnapshot = equippedWeapon.getSnapshot();
    // Published here rather than with aim intent because the reload phase only
    // exists after the weapon has updated. The motor reads it next frame.
    if (weaponIntent !== null) weaponIntent.reloading = weaponSnapshot.phase === "reloading";
    const nextScopeAdjustments = scopeAdjustments.get(equippedWeapon.definition.id)!;
    if (activeScopeAdjustments.current !== nextScopeAdjustments) {
      activeScopeAdjustments.current = nextScopeAdjustments;
      const scopeSnapshot = nextScopeAdjustments.getSnapshot();
      drawScopeStatus(scopeStatusMap, scopeSnapshot);
      combatTelemetry.publishScopeAdjustment(scopeSnapshot);
    }

    timelineFrame.deltaSeconds = simulationDelta;
    timelineFrame.endPosition.copy(shotOrigin);
    timelineFrame.endOrientation.copy(camera.quaternion);
    timelineFrame.stance = stance;
    timelineFrame.holdingBreath = scopeDemo && commands.holdingBreath;
    timelineFrame.swayHandlingMultiplier = weaponSnapshot.swayFactor;
    // Gameplay sway follows authoritative ADS progress, not the damped rig
    // blend: sway must not depend on whether the proxy GLTF finished loading.
    // A switch that completed inside this update changes which weapon owns that
    // progress, so do not interpolate between two unrelated ADS states.
    timelineFrame.adsProgressStart =
      equippedWeapon === weaponBeforeUpdate ? adsProgressBefore : equippedWeapon.adsProgress;
    timelineFrame.adsProgressEnd = equippedWeapon.adsProgress;
    timelineFrame.captureTrace = captureShotTrace;
    // Sway advance, per-boundary shot spawning, and projectile stepping all
    // happen inside this call, in cadence order on one timeline.
    const simulationStartedAt = performance.now();
    firingTimeline.runFrame(timelineFrame, loadout, timelineHandlers);
    const simulationMilliseconds = performance.now() - simulationStartedAt;
    ballisticPerformance.projectileMilliseconds += firingTimeline.projectileMilliseconds;

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
        projectileMillisecondsPerFrame:
          ballisticPerformance.projectileMilliseconds / ballisticPerformance.frames,
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
      ballisticPerformance.projectileMilliseconds = 0;
      ballisticPerformance.maxSimulationMilliseconds = 0;
      ballisticPerformance.frames = 0;
      ballisticPerformance.segmentQueries = projectileMetrics.segmentQueries;
      ballisticPerformance.terrainCellTests = queryMetrics.terrainCellTests;
      ballisticPerformance.colliderCandidates = queryMetrics.colliderCandidates;
    }
    ballistics.drainImpactEvents(handleImpact);
    ballistics.drainResults(handleBallisticResult);

    // No longer gated on having an optic: every weapon now moves for ADS, and one
    // without a lens takes the placeholder raise rather than staying at the hip.
    const aimTarget = scopeDemo ? equippedWeapon.adsProgress : 0;
    // Seeded from the definition on first sight, then the dev console owns it. Offline
    // only: `networked` weapons keep the canonical timings, for the same reason `?ammo=`
    // is refused online — the server scores with the authored values.
    const gameplayRigKey = weaponPresentationFor(equippedWeapon.definition.id).rigKey;
    weaponPoses.seedAdsTiming(
      gameplayRigKey,
      equippedWeapon.definition.ads.enterSeconds,
      equippedWeapon.definition.ads.exitSeconds
    );
    const adsOverride = networked ? null : weaponPoses.adsOverrideFor(gameplayRigKey);
    equippedWeapon.setAdsOverrideSeconds(adsOverride);
    // Raising and lowering are separately authored, so pick the one this frame is doing.
    // Without it a weapon that comes up fast and drops slow would blend at one rate both
    // ways, which is the same flattening at a smaller scale.
    const adsDefinition = adsOverride ?? equippedWeapon.definition.ads;
    const adsSeconds =
      aimTarget >= aim.current ? adsDefinition.enterSeconds : adsDefinition.exitSeconds;
    aim.current = THREE.MathUtils.damp(
      aim.current,
      aimTarget,
      AIM_RESPONSE_PER_ADS_SECOND / Math.max(MIN_ADS_SECONDS, adsSeconds),
      delta
    );
    // Damped beside the ADS blend, because the pose rotations below read both; computing
    // it after them would apply the previous frame's value.
    const sprintWanted = sprinting.current;
    sprintBlend.current = THREE.MathUtils.damp(
      sprintBlend.current,
      sprintWanted ? 1 : 0,
      SPRINT_BLEND_RESPONSE,
      delta
    );
    if (scopeDemo) {
      lookSensitivity.setOpticState(
        aim.current,
        aimSway.breathStabilization,
        CAMERA_FOV,
        // The equipped weapon's OWN optic, not a global one. `scopeFov` is a single value
        // seeded from the sniper's 5.5 degrees, so passing it unconditionally handed every
        // weapon a magnified weapon's sensitivity: aiming the pistol or the SAW — neither
        // of which has a lens — cut pointer speed by roughly the factor an 8x scope would,
        // for no magnification at all. A weapon with no optic sees no magnification, so its
        // ratio is 1 and aimed sensitivity equals hipfire.
        //
        // A deliberate per-weapon ADS sensitivity multiplier is a separate, deferred knob;
        // this only stops the unmagnified weapons inheriting the sniper's.
        hasOptic.current ? scopeFov.current : CAMERA_FOV
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
      // Fade the crosshair only for a weapon that has glass to replace it with. The
      // pistol and the LMG author no lens, so ADS raises them (see IRON_SIGHT_OFFSET)
      // without offering a sight picture — fading here would leave the player aiming at
      // nothing at all. Restore the fade for them once an authored iron sight exists.
      hasOptic.current ? 1 - THREE.MathUtils.smoothstep(aim.current, 0.15, 0.75) : 1,
      scopeDemo &&
        FPS_DEBUG.hipfireCrosshair &&
        document.pointerLockElement === gl.domElement &&
        crosshairPoint.z >= -1 &&
        crosshairPoint.z <= 1
    );
    combatTelemetry.publishWeapon(weaponSnapshot);

    // Both mixers, one delta. They were keyed frame-for-frame against each other, so
    // equal playback rate IS the synchronisation — and this deliberately takes the raw
    // render delta rather than the clamped simulation delta (docs/10 §3).
    weaponRig.current?.update(delta, { idleSpiceAllowed: aim.current < 0.02 });
    scopeActive.value = scopeDemo ? aim.current : 0;

    // Mouse-look rotates the camera immediately, but a held rifle has a small
    // positional lag. Feed that physical lag into the eyebox rather than
    // magnifying the constant breathing motion.
    // yawDelta/pitchDelta were measured at the top of the frame against the same
    // captured start pose the timeline used. A quick look produces a one-shot
    // impulse; unlike a velocity target it cannot be filtered away in one frame.
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
    // Raw render delta, like the rest of the presentation damping. Speed and grounded
    // come from the authoritative pose, so the gait follows the motor rather than a
    // differentiated camera position.
    // Repointed rather than copied: the store hands back a live config per weapon, so a
    // dial moved mid-frame is read on the next one without a subscription.
    weaponBob.setConfig(weaponPoses.bobFor(presentation.rigKey));
    weaponBob.update(
      delta,
      playerPose.planarSpeedMetresPerSecond,
      playerPose.grounded,
      aim.current
    );
    recoilPitch.current = THREE.MathUtils.damp(recoilPitch.current, 0, 8, delta);
    recoilYaw.current = THREE.MathUtils.damp(recoilYaw.current, 0, 10, delta);
    // Where the rig SITS is `WeaponRigPlacement`, and it rebuilds the transform from a
    // neutral camera-space root every frame — the mixers have already moved the skeleton
    // by now, and an incremental transform would leave ADS aligned to the previous frame's
    // pose. It owns the two orderings that are load-bearing (tilt before the optic is
    // measured; the ADS offset applied once, not twice) and both are asserted in
    // tests/fps/weapon-rig-placement.test.ts.
    //
    // A weapon with an optic aligns the glass to the eye and then applies eye relief. One
    // without — the pistol and LMG author no lens — has no anchor to align to, so its
    // stored `ads` offset is the whole raise: a PLACEHOLDER for the main-camera FOV aiming
    // path that claims no sight alignment, not a no-op.
    const opticAnchor = weaponRig.current?.optic ?? null;
    placementFrame.pose = weaponPoses.get(presentation.rigKey);
    placementFrame.sprintBlend = sprintBlend.current;
    placementFrame.adsBlend = aim.current;
    placementFrame.optic = hasOptic.current ? opticAnchor : null;
    placementFrame.swayXMetres = aimSway.positionXMetres;
    placementFrame.swayYMetres = aimSway.positionYMetres;
    placementFrame.swayYawRadians = aimSway.yawRadians;
    placementFrame.swayPitchRadians = aimSway.pitchRadians;
    placementFrame.lookLagXMetres = lookLag.x;
    placementFrame.lookLagYMetres = lookLag.y;
    placementFrame.recoilYawRadians = weaponSnapshot.recoilYawRadians + recoilYaw.current;
    placementFrame.recoilPitchRadians = weaponSnapshot.recoilPitchRadians + recoilPitch.current;
    placementFrame.bobXMetres = weaponBob.offsetX;
    placementFrame.bobYMetres = weaponBob.offsetY;
    placementFrame.bobZMetres = weaponBob.offsetZ;
    placementFrame.bobRollDegrees = weaponBob.roll;
    placementFrame.bobYawDegrees = weaponBob.yaw;
    placementFrame.bobPitchDegrees = weaponBob.pitch;
    placement.apply(rig, camera, placementFrame);

    weaponCamera.position.copy(camera.position);
    weaponCamera.quaternion.copy(camera.quaternion);
    weaponCamera.updateMatrixWorld();

    const renderer = gl as unknown as THREE.WebGPURenderer;
    if (scopeDemo && aim.current > 0.02 && opticAnchor) {
      opticAnchor.lens.localToWorld(opticWorld.copy(opticAnchor.centre));
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
