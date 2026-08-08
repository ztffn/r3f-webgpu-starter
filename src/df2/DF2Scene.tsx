// Scene composition: atmosphere, lights, water, terrain, camera.
//
// Loads a real extracted DF terrain if its prepared assets are present
// (see tools/df2-extract), otherwise falls back to synthetic fBm terrain.
//
// Both paths produce the SAME set of inputs — a pre-shaded colormap, an 8-bit
// elevation grid and a canopy field — so terrain and grass need no mode switch and
// the grass system is visible with no game data present.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { Terrain } from "./Terrain";
import { PerfMonitor, type PerfSample } from "./PerfMonitor";
import { FlyControls, type FlyState, type Stance } from "./FlyControls";
import { Heightfield } from "./Heightfield";
import { createTerrainMaterial, type TerrainDetailUniforms } from "./TerrainMaterial";
import { createGrassMaterial, type GrassUniforms } from "./GrassMaterial";
import type { FoliageDebugControls } from "../foliage/foliageDebug";
import { createBladeMaterial, createBladeMesh, type BladeUniforms } from "./BladeMaterial";
import { createColorGrade } from "./colorGrade";
import { createFog } from "./fog";
import { bakeNoiseTexture } from "./noiseTexture";
import { cubeTexture, normalWorldGeometry } from "three/tsl";
import { WEATHER_PRESETS, readWeather, lightingOf, type WeatherPreset } from "./weather";
import { createAtmosphere } from "./atmosphere";
import { createPrecipitation } from "./Precipitation";
import { buildBladeGeometry } from "./bladeGeometry";
import { readBallisticEnvironment } from "../combat/BallisticEnvironment.ts";
import { bakeSyntheticMaps } from "./syntheticMaps";
import { bakeGrassJitter } from "./grassJitter";
import { buildHeightTexture } from "./heightTexture";
import { loadTerrain, type LoadedTerrain } from "./loadTerrain";
import { WeaponPrototype } from "../fps/WeaponPrototype";
import { MotorControls } from "../fps/MotorControls";
import { useGameClient } from "../fps/useGameClient";
import type { GameClient } from "../net/GameClient.ts";
import type { RoomInfo } from "../net/ColyseusProtocol.ts";
import { useRoomVisuals, type RoomVisuals } from "../fps/useRoomVisuals";
import { usePlayerVitals } from "../fps/usePlayerVitals";
import { applyVisualDials, type VisualDialTargets } from "./visualDials";
import { RemotePlayers } from "../fps/RemotePlayers";
import { CompositeWorldQuery } from "../fps/core/WorldQuery";
import type {
  PlayerMotorSnapshotTarget,
  PlayerWeaponIntent,
} from "../fps/core/PlayerMotor";
import { FPS_DEBUG } from "../fps/debug/debugConfig";
import { LookSensitivityController } from "../fps/core/LookSensitivityController";
// Lazily imported so the three multi-megabyte debug models are code-split out of the
// main bundle and only fetched when ?targets=1 actually asks for them.
const TestTargets = lazy(() =>
  import("../fps/TestTargets").then((m) => ({ default: m.TestTargets }))
);
const NetworkTargets = lazy(() =>
  import("../fps/NetworkTargets").then((m) => ({ default: m.NetworkTargets }))
);
const RemoteFireEffects = lazy(() =>
  import("../fps/RemoteFireEffects").then((m) => ({ default: m.RemoteFireEffects }))
);
const BallisticTestRange = lazy(() =>
  import("../fps/BallisticTestRange").then((m) => ({ default: m.BallisticTestRange }))
);
const ShotTrajectoryDebugView = lazy(() =>
  import("../fps/presentation/ShotTrajectoryDebugView").then((m) => ({
    default: m.ShotTrajectoryDebugView,
  }))
);
const ImpactEffects = lazy(() =>
  import("../fps/presentation/ImpactEffects").then((m) => ({ default: m.ImpactEffects }))
);
// Code-split for the same reason: the vegetation layer is opt-in, so its geometry
// builders and texture bake should not sit in the bundle everyone downloads.
const FoliageLayer = lazy(() =>
  import("../foliage/FoliageLayer").then((m) => ({ default: m.FoliageLayer }))
);
import { BENCH } from "./bench";
import {
  FOLIAGE_FAR_RADIUS_METRES,
  FOLIAGE_SITE_SPACING,
  FOLIAGE_VIEW_RADIUS_METRES,
} from "../foliage/foliageConfig";
import { DevPlacedObject } from "./DevPlacedObject";
import { MissionObjects } from "./MissionObjects";
import type { TerrainScale } from "./config";
import {
  readMapSlug,
  TERRAIN_SLUG,
  CALIBRATED_TERRAIN_SCALE,
  HEIGHT_SCALE,
  lodSchedule,
  GRASS_SCALE,
  GRASS_STEPS,
  GRASS_STEPS_RUN,
  GRASS_CELL,
  GRASS_NEAR_CLIP,
  GRASS_REFINE_STEPS,
  GRASS_MAX_SPAN,
  GRASS_INSIDE_SPAN,
  GRASS_STRIPE_PIXELS,
  GRASS_HASH_PERIOD,
  GRASS_TONE_VARIATION,
  GRASS_SHADE_BASE,
  GRASS_STRAND_JITTER,
  GRASS_STRAND_MIX,
  GRASS_FADE_START,
  GRASS_FADE_END,
  GRASS_BLADE_COUNT,
  GRASS_BLADE_RADIUS,
  GRASS_BLADE_THIN_START,
  GRASS_BLADE_KEEP_MIN,
  GRASS_BLADE_WIDTH,
  GRASS_BLADE_HEIGHT_SCALE,
  GRASS_BLADE_SEGMENTS,
  GRASS_BLADE_V_DEPTH,
  GRASS_BLADE_SHADE_BASE,
  GRASS_BLADE_LIFT,
  GRASS_BLADE_BEND,
  GRASS_BLADE_TWIST,
  GRASS_BLADE_SUN,
  GRASS_BLADE_WIND_GAIN,
  GRASS_BLADE_PUSH_RADIUS,
  GRASS_BLADE_PUSH_STRENGTH,
  GRASS_BLADE_NOISE_SCALE,
  GRASS_BLADE_GUST_RATE,
  WATER_COLOR,
  SUN_DIRECTION,
  REFERENCE_P11,
} from "./config";

const SUN_DISTANCE = 2000;

/** Signal smoke is colour-coded; white is the screening kind. */
const SMOKE_COLORS = ["#e8e8ea", "#7b3fa0", "#d8c53a", "#c23a2a", "#3aa04a"];

/**
 * The fog range actually in force — the preset's, unless a bench flag overrides it.
 *
 * ONE resolver, because three separate things read this range: the shared term, three's
 * own declarative scene fog (which the water uses), and the water plane's own extent.
 * `?fogfar=` applied at only the first of those pulled terrain in to 350 m while the
 * water beside it stayed on the preset's 2200, so the two fogged on different curves —
 * a second artifact layered on whatever was being investigated.
 */
function fogRangeOf(w: WeatherPreset): { near: number; far: number } {
  return { near: BENCH.fogNear ?? w.fogNear, far: BENCH.fogFar ?? w.fogFar };
}

/** A preset's fog, in the shape `createFog` takes. */
function fogSettings(
  w: WeatherPreset,
  noise: THREE.Data3DTexture,
  wind: { x: number; z: number }
) {
  return {
    noise,
    wind,
    color: w.fogColor,
    ...fogRangeOf(w),
    groundTop: BENCH.fogTop ?? w.groundFogTop,
    // Below the terrain's own minimum, so every preset is ordinary ground fog until
    // something raises it. A band is a deliberate act, not a default.
    groundBase: BENCH.fogBase ?? w.groundFogBase,
    // Generous by default. A short scale height is a lid you can see the underside of;
    // 25 m puts the layer's own gradient well below the size of the terrain features it
    // is filling, which is what makes it read as air rather than as a surface.
    groundScale: 25,
    groundDensity: BENCH.fogDensity ?? w.groundFogDensity,
    // Wraps per metre: repeats every 100 m, so the layer's coarsest lumps are ~25 m —
    // banks of fog rather than texture on it.
    groundNoiseScale: 0.01,
    groundNoiseAmount: 0.35,
    groundDrift: 0.03,
  };
}

/**
 * Smoke: ages the live volumes, and throws one on G.
 *
 * A prototype, and scoped like one — the puff lands a fixed distance ahead of the eye
 * rather than being thrown, and nothing but the renderer knows it exists. Before this
 * could be a mechanic the volume has to become a field the concealment query reads too,
 * or smoke would hide a player on screen while the gameplay side still saw them, which
 * is the fairness break docs/08 §8 invariant 6 exists to prevent.
 */
function SmokeRig({
  fog,
  ready,
}: {
  fog: ReturnType<typeof createFog>;
  ready: boolean;
}): null {
  const camera = useThree((s) => s.camera);
  const placed = useRef(false);
  const thrown = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyN") return;
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const at = camera.position.clone().addScaledVector(forward, 12);
      // Cycles the colours, because signal smoke is colour-coded and one puff of each is
      // the quickest way to see whether they blend where they overlap.
      fog.spawnSmoke(at.x, at.y, at.z, SMOKE_COLORS[thrown.current++ % SMOKE_COLORS.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [camera, fog]);
  useFrame((_, dt) => {
    // Placed on the first RENDERED FRAME after the terrain is ready, not on mount and not
    // on ready. Two things happen before that which both put the puff somewhere useless:
    // the terrain decode runs for tens of seconds while frames are already going, so a
    // puff spawned at mount has expired before anything is visible; and the bench camera
    // is not at its pose until a frame has run, so one spawned on ready lands behind you.
    if (!placed.current && ready && BENCH.smoke) {
      placed.current = true;
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const at = camera.position.clone().addScaledVector(forward, BENCH.smoke);
      fog.spawnSmoke(at.x, at.y, at.z, SMOKE_COLORS[0]);
    }
    fog.tickSmoke(dt);
  });
  return null;
}

/**
 * Keeps the precipitation box on the camera.
 *
 * Its own component so the per-frame follow gets a `useFrame` without adding a hook to
 * DF2Scene for a system that may not exist — the box is built only for wet presets.
 */
function PrecipitationRig({
  precipitation,
}: {
  precipitation: ReturnType<typeof createPrecipitation>;
}): React.ReactElement {
  const camera = useThree((s) => s.camera);
  useFrame(() => precipitation.update(camera));
  return <primitive object={precipitation.object3D} />;
}

/**
 * Live handles for the debug panel.
 *
 * Deliberately the OBJECTS rather than their values: every one of these is driven by
 * assigning a uniform, which rebuilds nothing. The preset setter is the exception and
 * still rebuilds nothing, because the grade, the fog and the rain are constructed once
 * and updated through their setters.
 */
export interface SceneHandles {
  preset: WeatherPreset;
  /** Current rain, so the panel can seed its dial — the uniform is no longer readable. */
  rain: number;
  setPreset: (id: string) => void;
  /**
   * The room's authority over this scene's visuals, or null when playing alone.
   *
   * ONE object rather than sibling booleans. Its presence means the room owns the
   * weather — so `setPreset` is inert and the panel must SAY so, since a dead button
   * with no explanation is indistinguishable from a bug — and it also switches a dial
   * from writing a uniform to asking the server. Whether that ask is permitted is
   * `dialsAllowed` on the object itself. Every one of those is derivable from this,
   * so publishing them separately was three fields encoding one fact.
   */
  roomDials: RoomVisuals | null;
  /**
   * Foliage density multiplier, and its setter. Deliberately NOT a `VISUAL_DIALS` entry:
   * that table is append-only wire identity and room-authoritative, and cover is gameplay
   * rather than weather. Local only — see `BENCH.admin`.
   */
  foliageDensity: number;
  setFoliageDensity: (value: number) => void;
  /**
   * Spawner reach and site spacing. Both REBUILD the layer, so the panel commits them on
   * release; density is live because it does not.
   */
  foliageRadius: number;
  setFoliageRadius: (value: number) => void;
  foliageSpacing: number;
  setFoliageSpacing: (value: number) => void;
  /** Far impostor ring reach, metres; 0 disables it. Rebuilds the ring, not the field. */
  foliageFar: number;
  setFoliageFar: (value: number) => void;
  grade: ReturnType<typeof createColorGrade>;
  fog: ReturnType<typeof createFog>;
  precipitation: ReturnType<typeof createPrecipitation>;
  blades: BladeUniforms | null;
  terrainDetail: TerrainDetailUniforms | null;
  lights: VisualDialTargets["lights"];
}

export interface DF2SceneProps {
  wireframe?: boolean;
  grass?: boolean;
  grounded?: boolean;
  stance?: Stance;
  /**
   * Live terrain-scale override (dev console Scene tab). Changing it rebuilds
   * the whole world — heightfield, chunks, grass, motor terrain — so the owner
   * commits it on slider release, not per input tick. Real maps only; the
   * synthetic fallback keeps its own scale.
   */
  terrainScale?: TerrainScale;
  onPerf?: (s: PerfSample) => void;
  onFly?: (s: FlyState) => void;
  /** The room's join code, once a private room has sent it. */
  onRoomInfo?: (info: RoomInfo | null) => void;
  /**
   * The local player's health, 0–1, or null with no authority reporting it.
   *
   * Reported upward like room info rather than folded into `SceneHandles`: no
   * scene material reads it, and widening that memo would republish every scene
   * handle each time somebody took a bullet.
   */
  onHealth?: (health: number | null) => void;
  /**
   * The networked client itself, or null offline.
   *
   * The CLIENT, not anything derived from it. Deriving the combat feed in here
   * meant every death in the room re-rendered the whole scene subtree — terrain,
   * grass, water, precipitation, remotes — twice, once for the hook and once for
   * the state it fed back down. Handing the instance up lets the HUD subscribe
   * outside the canvas, where a re-render costs a few DOM nodes.
   */
  onClient?: (client: GameClient | null) => void;
  onToggleGround?: () => void;
  onStance?: (s: Stance) => void;
  onStatus?: (status: { loading: boolean; terrain: LoadedTerrain | null }) => void;
  /** Hands the grass shader's live uniforms out so a debug panel can drive them. */
  onGrassReady?: (u: GrassUniforms | null) => void;
  /** The same, for the vegetation layer — the Foliage tab writes these directly. */
  onFoliageDebugReady?: (c: FoliageDebugControls | null) => void;
  /** The same, for everything added this session: weather, fog, rain and blades. */
  onSceneReady?: (s: SceneHandles | null) => void;
  /** Renders the integrated first-person optic prototype on top of this world. */
  scopeDemo?: boolean;
  /** Isolated animated rifle-and-hands test scene. */
  weaponDemo?: boolean;
  /**
   * Walk on the shared character motor instead of the terrain spike's camera
   * rig. Opt-in: `FlyControls` stays the default because free flight is still
   * how the terrain and grass work gets judged.
   */
  motorDemo?: boolean;
  /**
   * Predict against the authoritative game server and show remote players.
   * Only meaningful with `motorDemo`; the local motor path is untouched
   * without it.
   */
  netDemo?: boolean;
}

/**
 * Water plane that follows the camera.
 *
 * The terrain tiles forever and its chunk window recentres every frame, so a plane
 * pinned to the world origin ran out: past its half-extent the camera flew over
 * terrain with no water and any basin below water level rendered dry. Snapped to a
 * coarse grid so it does not shimmer as it moves.
 */
function Water({ level, span, material }: { level: number; span: number; material: THREE.Material }) {
  const { camera } = useThree();
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(span, span), material);
    m.rotation.x = -Math.PI / 2;
    m.frustumCulled = false;
    return m;
  }, [span, material]);

  useEffect(() => () => mesh.geometry.dispose(), [mesh]);

  useFrame(() => {
    const step = span / 8;
    mesh.position.set(
      Math.round(camera.position.x / step) * step,
      level,
      Math.round(camera.position.z / step) * step
    );
  });

  return <primitive object={mesh} />;
}

export function DF2Scene({
  wireframe = false,
  grass = true,
  grounded = false,
  stance = "stand",
  terrainScale,
  onStatus,
  onPerf,
  onFly,
  onRoomInfo,
  onHealth,
  onClient,
  onToggleGround,
  onStance,
  onGrassReady,
  onFoliageDebugReady,
  onSceneReady,
  scopeDemo = false,
  weaponDemo = false,
  motorDemo = false,
  netDemo = false,
}: DF2SceneProps) {
  const lookSensitivity = useMemo(() => new LookSensitivityController(), []);
  /** Written by MotorControls each frame, read by WeaponPrototype the same frame. */
  const motorPose = useMemo<PlayerMotorSnapshotTarget>(
    () => ({
      position: new THREE.Vector3(),
      stance: "stand",
      grounded: false,
      sprinting: false,
      planarSpeedMetresPerSecond: 0,
    }),
    []
  );
  /** Aim intent the other way: weapon host writes, motor reads. */
  const weaponIntent = useMemo<PlayerWeaponIntent>(
    () => ({ aiming: false, reloading: false }),
    []
  );
  // undefined = still loading, null = no assets (synthetic), object = real map
  const [loaded, setLoaded] = useState<LoadedTerrain | null | undefined>(undefined);

  // The slug this client loads — also what the room's reported map is checked
  // against once ROOM_INFO arrives.
  const mapSlug = useMemo(
    () => readMapSlug(typeof window === "undefined" ? "" : window.location.search),
    []
  );

  useEffect(() => {
    let alive = true;
    // The heuristic HALF of the mismatch warning: a client-set ?map= against
    // the presumed-default server, warned before the join even resolves. The
    // definitive check is the ROOM_INFO effect below, which compares against
    // the map the room actually reports — this one exists because it can fire
    // even when the server is unreachable.
    if (netDemo && mapSlug !== TERRAIN_SLUG) {
      console.warn(
        `[DF2Scene] networked with ?map=${mapSlug} — the server must be running the same ` +
          `map (DF2_MAP=${mapSlug}) or movement will desync.`
      );
    }
    loadTerrain(mapSlug).then((t) => {
      if (alive) setLoaded(t);
    });
    return () => {
      alive = false;
    };
  }, [netDemo, mapSlug]);

  useEffect(() => {
    onStatus?.({ loading: loaded === undefined, terrain: loaded ?? null });
  }, [loaded, onStatus]);

  // One bundle for both modes: elevation bytes, colormap, canopy.
  const world = useMemo(() => {
    if (loaded === undefined) return null; // don't build anything while loading

    if (loaded) {
      // GameApp owns the dial state (URL seeds included); a DF2Scene mounted
      // without the prop builds at the shipped calibration. TerrainScale's
      // fields deliberately match HeightmapSource, so it spreads.
      const heightfield = Heightfield.fromHeightmap({
        data: loaded.heights,
        size: loaded.size,
        ...(terrainScale ?? CALIBRATED_TERRAIN_SCALE),
      });
      return {
        heightfield,
        heights: loaded.heights,
        heightSize: loaded.size,
        size: loaded.size,
        colorMap: loaded.colorMap,
        detail: loaded.detail,
        grassMap: loaded.grassMap,
        filter: loaded.filter,
        waterHeight: loaded.waterHeight,
      };
    }

    const bytes = Heightfield.syntheticBytes();
    const heightfield = Heightfield.fromHeightmap(bytes);
    const { colorMap, grassMap, size } = bakeSyntheticMaps(heightfield);
    return {
      heightfield,
      heights: bytes.data,
      // Elevation grid and colour grid differ here (see syntheticMaps). Both are
      // sampled by normalised uv, so only the COLOUR texel size matters downstream.
      heightSize: bytes.size,
      size,
      colorMap,
      detail: null,
      grassMap,
      filter: undefined,
      waterHeight: 0,
    };
  }, [loaded, terrainScale]);

  const heightfield = world?.heightfield ?? null;
  // The networked client's lifetime belongs to this scene, not to
  // MotorControls: RemotePlayers consumes the same instance, and an effect-owned
  // client is what guarantees a leaked join cannot outlive its component.
  // DECLARED BEFORE THE WEATHER BLOCK, because weather is now downstream of it:
  // when networked, the room's preset is authoritative and the URL's is not.
  const { client: gameClient, roomInfo } = useGameClient(motorDemo && netDemo, heightfield);
  // Reported upward like fly state and perf samples rather than folded into
  // SceneHandles: the room sends it once, well after the handles object is first
  // published, and widening that memo to re-run on it would republish every scene
  // handle for a fact no scene material reads.
  useEffect(() => {
    onRoomInfo?.(roomInfo);
  }, [onRoomInfo, roomInfo]);
  // The definitive map-mismatch check, covering BOTH directions: the heuristic
  // above only catches a client-set ?map=, but a server switched with
  // DF2_MAP=egypt against a default client was completely silent — the room's
  // metadata carried its map and nothing client-side read it. The server now
  // names its map in ROOM_INFO; disagreement is loud because the symptom
  // (rubber-banding on every slope) is otherwise undiagnosable.
  useEffect(() => {
    if (roomInfo?.map !== undefined && roomInfo.map !== mapSlug) {
      console.error(
        `[DF2Scene] map mismatch: this client loaded "${mapSlug}" but the room ` +
          `simulates "${roomInfo.map}". Movement WILL desync — rejoin with ` +
          `?map=${roomInfo.map}.`
      );
    }
  }, [roomInfo, mapSlug]);
  // Health takes the same route for the same reason. The hook is what subscribes;
  // this effect only forwards, so a change wakes the HUD and nothing in the scene.
  const health = usePlayerVitals(gameClient);
  useEffect(() => {
    onHealth?.(health);
  }, [onHealth, health]);
  useEffect(() => {
    onClient?.(gameClient);
  }, [onClient, gameClient]);
  /**
   * The room's visuals, or null when playing alone.
   *
   * Weather is AUTHORITATIVE when networked and that is a gameplay decision, not
   * tidiness: fog is concealment in this game, so two players in one match under
   * different fog ranges is a fairness bug. Same reasoning that makes the URL's
   * motor tuning overrides inert networked (docs/12 §9).
   */
  const room = useRoomVisuals(gameClient);
  const netWeather = room?.preset ?? null;
  /**
   * Claims an accepted shot to the server, or nothing when playing alone.
   *
   * Damage on another player is SERVER-ONLY. Offline there is no authority to ask,
   * so nothing is claimed and combat stays what it was — a local ballistic
   * simulation against local targets.
   */
  // Weapon switches and reloads are claims for the same reason shots are: the
  // server owns the loadout record that scores damage, so it has to hear about
  // what the player is holding and when the magazine cycles. One memo, three
  // callbacks — they share a lifetime because they share the client.
  const claims = useMemo(
    () =>
      gameClient === null
        ? null
        : {
            shot: (yawRadians: number, pitchRadians: number) =>
              gameClient.fire(yawRadians, pitchRadians),
            selectWeapon: (weaponIndex: number) => gameClient.selectWeapon(weaponIndex),
            reload: () => gameClient.reload(),
          },
    [gameClient]
  );

  // --- weather ---------------------------------------------------------------
  // ONE grade object for the three materials that sample the colormap, so a preset
  // moves ground, columns and blades together. Applying it per material is what made
  // the .trn `filter` a terrain-only tint — invisible while every extracted map ships
  // the neutral 128, and a visible seam the moment one does not.
  // STATE, not a memo of the URL, so the debug panel can switch presets live. The
  // objects it drives are built once and updated through their setters — rebuilding a
  // material would discard the terrain geometry cache and stall for about a second,
  // which is exactly the comparison a preset switch is for.
  const [weather, setWeather] = useState(() =>
    readWeather(typeof window === "undefined" ? "" : window.location.search)
  );
  // The initial preset, for the objects that are constructed once. A ref rather than the
  // state value so those constructions do not list `weather` as a dependency and rebuild
  // on every switch — which is the whole thing this arrangement exists to avoid.
  const weatherRef = useRef(weather);
  // The room's preset wins the moment it arrives. Everything downstream already
  // handles a live switch — this is the same path the debug panel drives.
  useEffect(() => {
    if (netWeather !== null) setWeather(netWeather);
  }, [netWeather]);
  // ONE noise texture for the whole renderer — fog, smoke and the blades' wind. They
  // cannot share a noise VALUE, since each samples at its own world position, but they
  // share this texture and therefore its cache. See noiseTexture.ts for why baking beats
  // computing here, and for the measurement that already proved it once.
  const noise = useMemo(() => bakeNoiseTexture(), []);
  // The one wind vector, read where every consumer reads it: grass bends to it, rain
  // slants on it, smoke leans on it, and it is what drifts the bullet.
  const windVector = useMemo(
    () =>
      readBallisticEnvironment(typeof window === "undefined" ? "" : window.location.search)
        .windVelocity,
    []
  );
  useEffect(() => () => noise.dispose(), [noise]);
  // Built once with the initial preset; every later change goes through `.set()` below.
  // A real map's own .trn values win over a neutral preset's, since they are what the
  // author graded the colormap for.
  const grade = useMemo(() => createColorGrade(weatherRef.current), []);
  const fog = useMemo(() => createFog(fogSettings(weatherRef.current, noise, windVector)), [noise]);
  // THE ONE THING A SCENE MATERIAL ASKS FOR. Grade and fog are still separate modules and
  // still separately dialled; this is the composition, so no material can get the order
  // wrong and none can quietly go without.
  const atmosphere = useMemo(() => createAtmosphere(grade, fog), [grade, fog]);

  /**
   * The preset's sky, as a cubemap.
   *
   * Loaded rather than awaited: three swaps it in when the six faces arrive, and until
   * then the flat background colour stands in. A sky is the one thing in this scene
   * that can afford to appear a frame late.
   *
   * Face order is three's own — +X, -X, +Y, -Y, +Z, -Z — against the pack's naming.
   */
  const skyBox = useMemo(() => {
    if (!weather.sky) return null;
    return new THREE.CubeTextureLoader()
      .setPath(`${import.meta.env.BASE_URL}assets/sky/${weather.sky}/`)
      // three's own axis order. The faces are stored under these names rather than the
      // source pack's directional ones, so a preset's folder says nothing about where
      // its images came from and swapping the pack touches no code.
      .load(["px.png", "nx.png", "py.png", "ny.png", "pz.png", "nz.png"]);
  }, [weather]);
  useEffect(() => () => skyBox?.dispose(), [skyBox]);

  // --- precipitation ----------------------------------------------------------
  // A camera-local box of drops, so a few thousand instances read as weather over an
  // infinite world. Dry presets build nothing at all rather than an idle system.
  const precipitation = useMemo(() => {
    return createPrecipitation({
      intensity: weatherRef.current.rain,
      mode: weatherRef.current.snow,
      maxCount: BENCH.rainCount,
      area: BENCH.rainArea,
      height: BENCH.rainHeight,
      // The one wind vector, not a second read of it — three transcriptions of "they
      // cannot disagree" is agreement by hand, which is the thing being avoided.
      wind: windVector,
    });
  }, [windVector]);
  useEffect(() => () => precipitation.dispose(), [precipitation]);

  // The sky as a NODE, not a texture, so the ground fog can reach it. Standing inside a
  // fog bank and seeing clear sky overhead is the tell that fog is painted on the terrain
  // rather than filling the air — the ray to the sky crosses the layer too, and along the
  // horizon it crosses an unbounded amount of it.
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    // The SAME cubemap the fog fades toward, so terrain and sky meet with no seam. Set
    // before the background, since applySky reads the haze the fog is holding.
    fog.setSky(skyBox);
    if (!skyBox) {
      scene.background = new THREE.Color(weather.skyColor);
      return;
    }
    scene.background = fog.applySky(cubeTexture(skyBox), normalWorldGeometry);
  }, [fog, scene, skyBox, weather]);

  const terrainKit = useMemo(
    () =>
      world?.colorMap
        ? createTerrainMaterial({
            colorMap: world.colorMap,
            atmosphere,
            detail: world.detail,
            metersPerTexel: world.heightfield.cellSize,
          })
        : null,
    [atmosphere, world]
  );
  const material = terrainKit?.material ?? null;
  useEffect(() => () => material?.dispose(), [material]);

  // --- columnar grass (docs/07) ---------------------------------------------
  const grassKit = useMemo(() => {
    if (!world?.grassMap || !world.colorMap) return null;
    // Elevation for the fragment march, carrying a mip chain decimated to the terrain
    // mesh's own LOD lattice so the two reconstruct the same surface — see
    // heightTexture.ts for why that matters and what it cost to get wrong.
    const heightTex = buildHeightTexture(world.heightfield);

    // Baked once per terrain and shared by every chunk. See grassJitter.ts for why
    // this is a texture rather than a hash evaluated in the march.
    const jitter = bakeGrassJitter(
      GRASS_HASH_PERIOD,
      BENCH.strand ?? GRASS_STRAND_JITTER
    );

    const kit = createGrassMaterial({
      grassMap: world.grassMap,
      jitterMap: jitter,
      heightMap: heightTex,
      // The march selects its mip with the SAME schedule Terrain.tsx picks chunk LOD
      // with, from one shared derivation — see config.lodSchedule.
      ...lodSchedule(world.heightfield.worldSize),
      texelSize: world.heightfield.cellSize,
      colorMap: world.colorMap,
      atmosphere,
      worldSize: world.heightfield.worldSize,
      grassScale: GRASS_SCALE,
      // ?steps= raises the compiled CEILING as well as the running value, so asking for
      // more samples than the shipped ceiling just works instead of being silently
      // clamped to it.
      steps: Math.max(GRASS_STEPS, BENCH.steps ?? 0),
      stepsRun: BENCH.steps ?? GRASS_STEPS_RUN,
      cellSize: GRASS_CELL,
      nearClip: GRASS_NEAR_CLIP,
      refineSteps: BENCH.refine ?? GRASS_REFINE_STEPS,
      maxSpan: BENCH.maxspan ?? GRASS_MAX_SPAN,
      insideSpan: GRASS_INSIDE_SPAN,
      stripePixels: GRASS_STRIPE_PIXELS,
      hashPeriod: GRASS_HASH_PERIOD,
      toneVariation: GRASS_TONE_VARIATION,
      shadeBase: GRASS_SHADE_BASE,
      strandMix: GRASS_STRAND_MIX,
      canopyForce: BENCH.canopyAll ?? false,
      fadeStart: GRASS_FADE_START,
      fadeEnd: GRASS_FADE_END,
      referenceP11: REFERENCE_P11,
    });
    return { ...kit, heightTex, jitterTex: jitter };
  }, [atmosphere, world]);

  useEffect(
    () => () => {
      grassKit?.material.dispose();
      grassKit?.capMaterial.dispose();
      grassKit?.heightTex.dispose();
      grassKit?.jitterTex.dispose();
    },
    [grassKit]
  );

  // --- near-field blade layer (docs/03 §4.4) --------------------------------
  // Built from the march's OWN field object, not from a second set of samplers, so
  // blade height, placement and colour cannot drift from the columns they stand among.
  //
  // The mesh never moves and is not parented to anything: each blade derives its world
  // position from `cameraPosition` in the vertex stage, so the field follows the player
  // without a per-frame CPU update and without the camera-graph trap the grass cap has
  // to work around (Terrain.tsx).
  const bladeKit = useMemo(() => {
    if (!grassKit || !world?.colorMap) return null;
    if (BENCH.blades === false) return null;
    const blade = createBladeMaterial({
      field: grassKit.field,
      colorMap: world.colorMap,
      atmosphere,
      count: BENCH.bladeCount ?? GRASS_BLADE_COUNT,
      radius: BENCH.bladeRadius ?? GRASS_BLADE_RADIUS,
      thinStart: GRASS_BLADE_THIN_START,
      keepMin: GRASS_BLADE_KEEP_MIN,
      heightScale: GRASS_BLADE_HEIGHT_SCALE,
      bend: GRASS_BLADE_BEND,
      twist: GRASS_BLADE_TWIST,
      // The same V depth the geometry below is built with — the normal is synthesised
      // from it, so the two cannot be allowed to disagree.
      vDepth: GRASS_BLADE_V_DEPTH,
      sun: BENCH.bladeSun ?? GRASS_BLADE_SUN,
      noise,
      sunDirection: SUN_DIRECTION,
      windGain: GRASS_BLADE_WIND_GAIN,
      pushRadius: BENCH.bladePushRadius ?? GRASS_BLADE_PUSH_RADIUS,
      pushStrength: BENCH.bladePush ?? GRASS_BLADE_PUSH_STRENGTH,
      noiseScale: GRASS_BLADE_NOISE_SCALE,
      gustRate: GRASS_BLADE_GUST_RATE,
      toneVariation: GRASS_TONE_VARIATION,
      shadeBase: BENCH.bladeShade ?? GRASS_BLADE_SHADE_BASE,
      lift: BENCH.bladeLift ?? GRASS_BLADE_LIFT,
      // The one wind vector — see windVector above.
      wind: windVector,
      debug: BENCH.bladeDebug ?? 0,
    });
    // Geometry after the material, because the material rounds the requested pool to a
    // square lattice and the geometry carries that count.
    const geometry = buildBladeGeometry(
      {
        segments: GRASS_BLADE_SEGMENTS,
        width: GRASS_BLADE_WIDTH,
        vDepth: GRASS_BLADE_V_DEPTH,
      },
      blade.count
    );
    return { mesh: createBladeMesh(geometry, blade), uniforms: blade.uniforms };
  }, [atmosphere, grassKit, noise, windVector, world]);

  useEffect(
    () => () => {
      bladeKit?.mesh.geometry.dispose();
      (bladeKit?.mesh.material as THREE.Material | undefined)?.dispose();
    },
    [bladeKit]
  );

  useEffect(() => {
    onGrassReady?.(grassKit?.uniforms ?? null);
  }, [grassKit, onGrassReady]);

  /**
   * Everything the dials can also write, in one object.
   *
   * ONE literal, because the panel READS through it (`VISUAL_DIALS[id].get`) and the
   * room WRITES through it — two hand-kept lists of the same five fields is exactly
   * the drift `visualDials.ts` exists to prevent.
   */
  // Preset lighting, recomputed when the preset changes; the refs below let the
  // Lighting dials write the live lights without a re-render.
  const lighting = useMemo(() => lightingOf(weather), [weather]);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const fillRef = useRef<THREE.HemisphereLight>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  // Stable across every re-render, so dialTargets does not churn a nested object
  // each time fog or grade changes.
  const lights = useMemo(() => ({ sun: sunRef, fill: fillRef, ambient: ambientRef }), []);

  const dialTargets = useMemo<VisualDialTargets>(
    () => ({
      rain: BENCH.rain ?? weather.rain,
      grade,
      fog,
      precipitation,
      blades: bladeKit?.uniforms ?? null,
      terrainDetail: terrainKit?.detail ?? null,
      lights,
    }),
    [bladeKit, fog, grade, precipitation, terrainKit, weather]
  );

  /**
   * The PRESET's writes into the shared uniforms — grade, fog, precipitation.
   *
   * SPLIT from the room-override apply below, and the split is load-bearing
   * for OFFLINE dials: grade, fog and precipitation are constructed once and
   * survive a world rebuild, so this effect must not re-run just because
   * terrainKit or bladeKit changed identity. It used to (via dialTargets), and
   * offline — where no room override ever re-applies — a texel commit snapped
   * every dialled fog and grade value back to the preset while the Weather
   * tab's sliders still showed the dialled numbers. Hence also `loaded` rather
   * than `world` for the .trn filter: the filter is the MAP's, stable across
   * scale rebuilds.
   *
   * `weather` IS A DEPENDENCY, and leaving it out is what made the preset
   * buttons look dead. These are imperative writes into live uniforms, so an
   * effect that never re-runs leaves them frozen at whatever the URL loaded
   * with — while the sky still swapped, because that memo does list `weather`.
   * A preset appeared to half-work: new sky, same graded ground, same fog range.
   *
   * ORDERING with the override effect below: preset first, overrides on top.
   * They are DECLARED adjacent in that order, and any commit that runs both
   * runs them in declaration order — a preset switch changes `weather`, which
   * changes dialTargets, so both fire together and the room's dialled fog
   * survives the switch. Do not reorder or separate these two effects.
   */
  useEffect(() => {
    // A real map's own .trn values win over a neutral preset's, since they are what
    // the author graded the colormap for.
    grade.set(
      loaded?.filter && weather.id === "day"
        ? { filter: loaded.filter, gamma: 128, saturation: 128 }
        : weather
    );
    fog.set(fogSettings(weather, noise, windVector));
    // `?rain=` and `?snow=` override the preset, so weather can be had WITHOUT its sky —
    // a downpour under a clear sky is a legitimate thing to want to look at, and tying
    // precipitation to the preset made it reachable only by changing the whole scene.
    precipitation.setIntensity(BENCH.rain ?? weather.rain);
    precipitation.uniforms.mode.value = BENCH.snow ?? weather.snow;
  }, [fog, grade, loaded, noise, precipitation, weather, windVector]);

  /**
   * The room's dial overrides, applied over whatever the preset just wrote —
   * and re-applied onto FRESH uniforms after a world rebuild (dialTargets
   * changes identity when terrainKit/bladeKit rebuild, and the new detail and
   * blade uniforms start at their defaults). Offline (room === null) this is a
   * no-op, which is exactly what keeps offline-dialled atmosphere alive across
   * rebuilds. See the ordering note on the preset effect above.
   */
  useEffect(() => {
    if (room !== null) applyVisualDials(dialTargets, room.overrides);
  }, [dialTargets, room]);

  // A local switch is REFUSED, not merely overwritten, once the room owns the
  // weather: the server broadcasts on change only, so nothing would ever arrive
  // to correct it and the two players would sit in different fog indefinitely.
  // Live foliage density. Seeded from `?foliagedensity=` so a URL and the slider agree,
  // then owned here because the layer must not rebuild to change it.
  const [foliageDensity, setFoliageDensity] = useState(BENCH.foliageDensity ?? 1);
  const [foliageRadius, setFoliageRadius] = useState(
    BENCH.foliageRadius ?? FOLIAGE_VIEW_RADIUS_METRES
  );
  const [foliageSpacing, setFoliageSpacing] = useState(FOLIAGE_SITE_SPACING);
  const [foliageFar, setFoliageFar] = useState(BENCH.foliageFar ?? FOLIAGE_FAR_RADIUS_METRES);

  const setPreset = useCallback(
    (id: string) => {
      if (netWeather !== null) return;
      setWeather(WEATHER_PRESETS[id] ?? WEATHER_PRESETS.day);
    },
    [netWeather]
  );

  useEffect(() => {
    // Spread of dialTargets, not a second field list: SceneHandles structurally
    // extends VisualDialTargets, and two hand-kept copies of the same fields is
    // exactly the drift the dialTargets comment above warns about.
    onSceneReady?.({
      ...dialTargets,
      preset: weather,
      setPreset,
      roomDials: room,
      foliageDensity,
      setFoliageDensity,
      foliageRadius,
      setFoliageRadius,
      foliageSpacing,
      setFoliageSpacing,
      foliageFar,
      setFoliageFar,
    });
  }, [
    dialTargets,
    foliageDensity,
    foliageRadius,
    foliageSpacing,
    foliageFar,
    onSceneReady,
    room,
    setPreset,
    weather,
  ]);

  // Stable identity so Terrain's slot memo does not rebuild; reads the uniform at
  // call time so the canopy slider takes effect without a React render.
  const grassCanopyMax = useCallback(
    () => Number(grassKit?.uniforms.canopyMax.value ?? 0),
    [grassKit]
  );

  const waterMaterial = useMemo(() => {
    // Lit, so it takes the term after lighting. docs/08 §8 invariant 7 named the water as
    // one of three surfaces bypassing the atmosphere entirely; it had been taking three's
    // linear scene fog, which fades to a flat colour while the terrain it meets at the
    // shoreline fades to the sky.
    const WaterMaterial = atmosphere.litClass(THREE.MeshStandardNodeMaterial);
    const m = new WaterMaterial();
    m.color = new THREE.Color(WATER_COLOR);
    m.roughness = 0.15;
    m.transparent = true;
    m.opacity = 0.82;
    return m;
  }, [atmosphere]);
  useEffect(() => () => waterMaterial.dispose(), [waterMaterial]);

  // Gameplay collision reads the canonical CPU heightfield, never Terrain's
  // transient LOD meshes or shader-only grass proxies.
  const worldQuery = useMemo(() => new CompositeWorldQuery(heightfield, 0), [heightfield]);
  // .trn water_height is in raw elevation units, same scale as the heightmap.
  // `?water=` forces a level, because no map in this pack has one — every .trn ships
  // water_height 0, which is below the terrain's own minimum, so the plane never draws
  // and the submerged path has never been exercised.
  // The heightfield's OWN scale, not the config constant — the terrain is built
  // at the live dial value, and water that reads a different scale parts company
  // with the ground the moment the height slider moves.
  const waterLevel =
    BENCH.water ?? (world?.waterHeight ?? 0) * (heightfield?.heightScale ?? HEIGHT_SCALE);
  const showWater = !!heightfield && waterLevel > heightfield.minHeight;
  // Follows the camera, so it only has to out-reach the fog, not the world — and the
  // preset's fog, since a weather preset can pull the far distance in.
  const waterSpan = fogRangeOf(weather).far * 3;

  return (
    <>
      {onPerf && <PerfMonitor onSample={onPerf} />}

      {/* The background is set imperatively in an effect above, because it is a NODE
          rather than a texture — it has to be fogged, and a plain cubemap cannot be. */}
      {/* Scene fog stays declared for what is STILL on three's automatic path, which is
          now only the GLB-loaded surfaces: mission props, dev-placed objects and the
          soldier, all of which arrive as plain non-node materials from the loader. Water
          and foliage moved to `atmosphere.shadeLit` and set `fog = false` themselves.
          Terrain and grass never used it. Once the GLB material pass lands this
          declaration has no consumer left and should go — a live scene fog that nothing
          reads is a trap for the next material added. */}
      <fog
        attach="fog"
        args={[weather.fogColor, fogRangeOf(weather).near, fogRangeOf(weather).far]}
      />

      {/* Sun. The terrain is unlit (its colormap is pre-shaded); this lights the
          water and anything else added to the scene later. */}
      {/* Lighting comes from the PRESET, not constants: a hardcoded 2.4 sun left
          props in full daylight at night while the unlit terrain went dark
          around them. Contrast is the sun-to-fill ratio, so overcast raises
          fill as it lowers sun rather than just dimming (weather.ts
          `lightingOf`). Live handles so the Lighting dials can drive them. */}
      <directionalLight
        ref={sunRef}
        position={[
          SUN_DIRECTION[0] * SUN_DISTANCE,
          SUN_DIRECTION[1] * SUN_DISTANCE,
          SUN_DIRECTION[2] * SUN_DISTANCE,
        ]}
        intensity={lighting.sunIntensity}
        color={lighting.sunColor}
      />
      {/* Sky/ground bounce */}
      {/* Props, not `args`: `args` makes R3F reconstruct the light on a preset
          switch, which swaps `fillRef.current` out from under the Lighting
          dials. Its two siblings are patched in place; this now matches. */}
      {/* fillSkyColor, not weather.skyColor: the fill's colour is what the sky
          CASTS, and a near-black night sky multiplied into any intensity kept
          the "Sky fill" dial visibly inert on dark presets (weather.ts). */}
      <hemisphereLight
        ref={fillRef}
        color={lighting.fillSkyColor}
        groundColor={lighting.groundColor}
        intensity={lighting.fillIntensity}
        position={[0, 400, 0]}
      />
      {/* Flat floor, so a face pointing away from sun AND sky is dark, not black */}
      <ambientLight ref={ambientRef} intensity={lighting.ambientIntensity} />

      {heightfield && material && (
        <Terrain
          heightfield={heightfield}
          material={material}
          grassMaterial={grassKit?.material ?? null}
          grassCapMaterial={
            BENCH.grassCap === false ? null : grassKit?.capMaterial ?? null
          }
          grassEnabled={grass}
          grassDistance={GRASS_FADE_END}
          // Read live: the debug panel writes this uniform without a React render.
          grassCanopyMax={grassCanopyMax}
          wireframe={wireframe}
        />
      )}

      {/* Blades ride on top of the march rather than replacing it: a gap in blade
          coverage over bare-looking ground would show where the concealment field
          counts a target hidden (docs/08 §8 invariant 6). Rendered here rather than
          inside the terrain group because the mesh needs no transform at all. */}
      {bladeKit && grass && <primitive object={bladeKit.mesh} />}

      <PrecipitationRig precipitation={precipitation} />
      <SmokeRig fog={fog} ready={!!heightfield} />

      {/* Scope mode promotes the contrast ladder into resettable shootable targets. */}
      {(BENCH.targets || (scopeDemo && !FPS_DEBUG.impactTest)) && heightfield && (
        <Suspense fallback={null}>
          <TestTargets
            heightfield={heightfield}
            originX={BENCH.targets ? (BENCH.x ?? 5) : 0}
            originZ={BENCH.targets ? (BENCH.z ?? 375) : 320}
            worldQuery={worldQuery}
          />
        </Suspense>
      )}

      {scopeDemo && FPS_DEBUG.impactTest && heightfield && (
        <Suspense fallback={null}>
          <BallisticTestRange heightfield={heightfield} worldQuery={worldQuery} />
        </Suspense>
      )}

      {showWater && <Water level={waterLevel} span={waterSpan} material={waterMaterial} />}

      {heightfield && <DevPlacedObject heightfield={heightfield} />}
      {heightfield && <MissionObjects heightfield={heightfield} />}
      {/* Vegetation — bushes and trees, opt-in with ?foliage=1 while it is exploratory,
          so no existing grass measurement changes underneath anyone. */}
      {BENCH.foliage && heightfield && (
        <Suspense fallback={null}>
          <FoliageLayer
            terrain={heightfield}
            atmosphere={atmosphere}
            density={foliageDensity}
            radiusMetres={foliageRadius}
            siteSpacing={foliageSpacing}
            farRadiusMetres={foliageFar}
            lights={lights}
            worldQuery={worldQuery}
            waterHeight={showWater ? waterLevel : undefined}
            onDebugReady={onFoliageDebugReady}
          />
        </Suspense>
      )}

      {scopeDemo && FPS_DEBUG.shotTrajectory && (
        <Suspense fallback={null}>
          <ShotTrajectoryDebugView />
        </Suspense>
      )}

      {(scopeDemo || (netDemo && gameClient !== null)) && (
        <Suspense fallback={null}>
          <ImpactEffects />
        </Suspense>
      )}

      {/* Exactly one camera owner. Both write camera.position every frame, so
          mounting them together makes the view fight itself. */}
      {heightfield && !motorDemo && (
        <FlyControls
          heightfield={heightfield}
          grounded={grounded}
          stance={stance}
          pointerLock={scopeDemo}
          lookSensitivity={lookSensitivity}
          onState={onFly}
          onToggleGround={onToggleGround}
          onStance={onStance}
        />
      )}

      {/* Mounted before WeaponPrototype so the pose is published first. Not a
          correctness requirement — a one-frame lag would be imperceptible — but
          free to get right. Networked mode withholds the mount until the client
          exists, so MotorControls' contract stays binary: client prop present
          means networked, absent means the unchanged local path. */}
      {heightfield && motorDemo && (!netDemo || gameClient !== null) && (
        <MotorControls
          heightfield={heightfield}
          client={netDemo ? gameClient : null}
          pointerLock={scopeDemo}
          lookSensitivity={lookSensitivity}
          onState={onFly}
          onStance={onStance}
          pose={motorPose}
          weaponIntent={weaponIntent}
        />
      )}

      {netDemo && gameClient !== null && (
        <>
          <RemotePlayers client={gameClient} atmosphere={atmosphere} />
          <Suspense fallback={null}>
            {/* Other players' shots as theatre, and the room's shared targets.
                Both are replicated presentation over the server's truth. */}
            <RemoteFireEffects client={gameClient} worldQuery={worldQuery} />
            <NetworkTargets
              client={gameClient}
              worldQuery={worldQuery}
              atmosphere={atmosphere}
            />
          </Suspense>
        </>
      )}

      {/* Kept opt-in while the existing terrain visual work remains the default.
          `?scene=scope&motor=1` mounts both, which is the combination that makes
          movement actually affect the weapon. */}
      {(scopeDemo || weaponDemo) && (
        <WeaponPrototype
          scopeDemo={scopeDemo}
          worldQuery={worldQuery}
          stance={stance}
          grounded={grounded}
          lookSensitivity={lookSensitivity}
          motorPose={motorDemo ? motorPose : null}
          weaponIntent={motorDemo ? weaponIntent : null}
          onShotFired={claims?.shot ?? null}
          onWeaponSelected={claims?.selectWeapon ?? null}
          onReloadStarted={claims?.reload ?? null}
        />
      )}
    </>
  );
}
