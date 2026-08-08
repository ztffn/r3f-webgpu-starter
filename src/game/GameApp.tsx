// The playable scene — everything below this module pulls in Three.js.
//
// Reached only through a dynamic import from the /play route (src/site/routes.tsx),
// which is what keeps ~1.5 MB of renderer off the landing page. Nothing in
// src/site/ or src/ui/ may import this file or anything it imports; the boundary
// is invisible until something crosses it and then it costs megabytes.

import { useCallback, useEffect, useRef, useState } from "react";
import "../styles.css";
import { GameCanvas } from "../components/GameCanvas";
import { GameHud } from "../hud/GameHud";
import { DevConsole } from "../devtools/DevConsole";
import { useDevConsole } from "../devtools/useDevConsole";
import {
  allPanels,
  loadPanelAlpha,
  loadPanelVisibility,
  savePanelAlpha,
  savePanelVisibility,
  type HudPanelId,
  type HudPanelVisibility,
} from "../hud/hudPanels";
import { EXPLICIT_LAUNCH_PARAMS } from "../ui/launchParams";
import { DF2Scene, type SceneHandles } from "../df2/DF2Scene";
import type { GrassUniforms } from "../df2/GrassMaterial";
import type { FoliageDebugControls } from "../foliage/foliageDebug";
import type { FlyState, Stance } from "../df2/FlyControls";
import type { RoomInfo } from "../net/ColyseusProtocol";
import { useCombatFeed } from "../fps/useCombatFeed";
import type { GameClient } from "../net/GameClient";
import type { LoadedTerrain } from "../df2/loadTerrain";
import type { PerfSample } from "../df2/PerfMonitor";
import { BENCH, publish } from "../df2/bench";
import {
  CALIBRATED_TERRAIN_SCALE,
  clampTerrainScale,
  type TerrainScale,
} from "../df2/config";

interface LaunchConfig {
  scopeDemo: boolean;
  weaponDemo: boolean;
  /**
   * Walk the shared character motor instead of the terrain spike's camera rig.
   *
   * Orthogonal to the scene on purpose: `?scene=motor` is movement alone, and
   * `?scene=scope&motor=1` is the combination that matters — a weapon carried by
   * a body that actually collides, so stance, speed and being airborne reach
   * weapon handling instead of being inferred from the camera.
   */
  motorDemo: boolean;
  /**
   * Networked play: the motor predicts against the authoritative game server and
   * remote players appear in the world. `?scene=scope&motor=1&net=1`, with an
   * optional `server=` URL override (default: dev game server, or same origin on
   * a deploy). Requires the motor — there is nothing to network without it.
   */
  netDemo: boolean;
  /**
   * Render the HUD panels that have no data source yet — objective and squad chat.
   *
   * They exist so the redesign can be compared 1:1 against
   * `design/df2-hud-1to1-html-v3`, and they are OFF by default because a scripted
   * objective that nothing will ever update is a lie a player would believe.
   * This is NOT "the HUD" — hiding that is `?hud=0` below.
   */
  hudPreview: boolean;
  /**
   * `?hud=0`: start with every HUD panel hidden — compass, crosshair, vitals,
   * all of it — for clean captures. It seeds the same per-panel visibility the
   * dev console's HUD tab edits, so panels can still be brought back live, and
   * combat FEEDBACK still renders for the same reason that tab has no switch
   * for it.
   */
  hud: boolean;
}

/**
 * Read once per MOUNT, not at module scope: the router reuses this chunk across
 * client-side navigations, and module constants would still describe whatever
 * URL first evaluated the module — a lobby join after a landing-page visit is
 * exactly that sequence.
 *
 * An unparameterised /play (in practice `/play?loadout=0`, arriving from the
 * loadout screen's deploy — routes.tsx bounces a truly bare /play to that screen
 * first) defaults to `scene=scope&motor=1&net=1`: the full game is the product
 * now. Any explicit parameter keeps the URL's documented meaning to the letter
 * (so `?scene=motor` is still offline, `?bench=1` still measures the spike), and
 * the spike itself stays reachable as `?scene=terrain`.
 */
function readLaunchConfig(): LaunchConfig {
  const urlParams = new URLSearchParams(window.location.search);
  // Which parameters are explicit — and which, like the funnel's `loadout`
  // token or `room`, deliberately are not — is declared per-parameter in
  // launchParams.ts, the one copy of the vocabulary.
  const explicit = EXPLICIT_LAUNCH_PARAMS.some((key) => urlParams.has(key));
  const requestedScene = urlParams.get("scene") ?? (explicit ? null : "scope");
  const motorDemo =
    requestedScene === "motor" || urlParams.get("motor") === "1" || !explicit;
  return {
    scopeDemo: requestedScene === "scope",
    weaponDemo: requestedScene === "weapon",
    motorDemo,
    netDemo: motorDemo && (urlParams.get("net") === "1" || !explicit),
    hudPreview: urlParams.get("hudpreview") === "1",
    hud: urlParams.get("hud") !== "0",
  };
}

export default function GameApp() {
  // useState initializer rather than a plain call, so one mount reads one URL.
  const [{ scopeDemo, weaponDemo, motorDemo, netDemo, hudPreview, hud }] =
    useState(readLaunchConfig);

  // The game owns the viewport and must never scroll; the site must. Set as a
  // class rather than a global stylesheet rule because this module's CSS is
  // injected on first visit and never removed — a global `overflow: hidden` left
  // every site page unscrollable for the rest of the session.
  //
  // On documentElement AS WELL AS body, and both are load-bearing: the canvas
  // sizes to a chain of percentage heights, and html needs a definite height or
  // the whole chain collapses to a 150px sliver (see tokens.css).
  useEffect(() => {
    document.documentElement.classList.add("mode-game");
    document.body.classList.add("mode-game");
    return () => {
      document.documentElement.classList.remove("mode-game");
      document.body.classList.remove("mode-game");
    };
  }, []);

  // `?debug=1` starts it open; backtick toggles it either way.
  const devConsole = useDevConsole(BENCH.debug === true);

  // HUD panel visibility and the panel-opacity dial, owned here because GameApp
  // is where the HUD and the dev console meet. Session-persisted so a reload to
  // rebake a URL parameter does not cost the debugging posture — unless the URL
  // says `hud=0`, which overrides the stored posture with everything off.
  const [hudPanels, setHudPanels] = useState<HudPanelVisibility>(() =>
    hud ? loadPanelVisibility() : allPanels(false)
  );
  // Only CONSOLE edits persist. Without this guard the persistence effect runs
  // on mount too, and a `?hud=0` visit would write its all-hidden override into
  // the stored posture — leaving the next ordinary visit with a blank HUD.
  const hudPanelsTouched = useRef(false);
  const setHudPanel = useCallback((id: HudPanelId, visible: boolean) => {
    hudPanelsTouched.current = true;
    setHudPanels((was) => ({ ...was, [id]: visible }));
  }, []);
  const setAllHudPanels = useCallback((visible: boolean) => {
    hudPanelsTouched.current = true;
    setHudPanels(allPanels(visible));
  }, []);
  const [panelAlpha, setPanelAlpha] = useState<number>(loadPanelAlpha);
  // Persisted in effects rather than inside the setters: the updater stays pure
  // (StrictMode double-invokes it), "show all" costs one write instead of nine,
  // and the opacity slider's drag persists once per commit instead of per event.
  useEffect(() => {
    if (hudPanelsTouched.current) savePanelVisibility(hudPanels);
  }, [hudPanels]);
  useEffect(() => {
    const timer = window.setTimeout(() => savePanelAlpha(panelAlpha), 300);
    return () => window.clearTimeout(timer);
  }, [panelAlpha]);

  const [wireframe, setWireframe] = useState(false);
  const [grass, setGrass] = useState(BENCH.grass ?? true);
  // ?bench=1 always starts on foot: the ground-level frame is the one being tuned.
  // The motor is always on foot — it has no fly mode to toggle out of.
  const [grounded, setGrounded] = useState(
    BENCH.enabled || scopeDemo || weaponDemo || motorDemo
  );
  const [stance, setStance] = useState<Stance>(BENCH.stance ?? "stand");
  // Calibration state (docs runbook W1): URL dials seed it, the Scene tab's
  // sliders commit into it on release, DF2Scene rebuilds the world from it.
  //
  // OFFLINE ONLY, like the sliders (bench.ts says why): the server simulates
  // the calibrated scale, so a networked client seeded from a leftover
  // calibration URL would disagree with every authoritative position and
  // rubber-band forever — with no warning, unlike the ?map= mismatch case.
  // And CLAMPED to the same bounds as the sliders: the raw URL path accepted
  // ?texel=0 (NaN world) and ?hsmooth=1000000 (frozen tab).
  const [terrainScale, setTerrainScale] = useState<TerrainScale>(() =>
    netDemo
      ? CALIBRATED_TERRAIN_SCALE
      : clampTerrainScale({
          metersPerTexel: BENCH.texel ?? CALIBRATED_TERRAIN_SCALE.metersPerTexel,
          heightScale: BENCH.heightScale ?? CALIBRATED_TERRAIN_SCALE.heightScale,
          smoothPasses: BENCH.heightSmooth ?? CALIBRATED_TERRAIN_SCALE.smoothPasses,
        })
  );

  const [perf, setPerf] = useState<PerfSample | null>(null);
  const [fly, setFly] = useState<FlyState | null>(null);
  // The room's join code, once a private room has sent it. Null for a public room
  // and when playing offline.
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  /** Null offline and until the first snapshot; see VitalsPanel for why not 1. */
  const [health, setHealth] = useState<number | null>(null);
  // Held so the feed can be derived HERE, outside the canvas: a kill must not
  // reconcile the scene tree, and this component renders only the HUD.
  const [client, setClient] = useState<GameClient | null>(null);
  const feed = useCombatFeed(client);

  const [status, setStatus] = useState<{ loading: boolean; terrain: LoadedTerrain | null }>({
    loading: true,
    terrain: null,
  });

  // The scene reports through callbacks rather than owning this state, so the
  // HUD can re-render on telemetry without ever re-rendering the canvas tree.
  const onPerf = useCallback((s: PerfSample) => setPerf(s), []);
  const onFly = useCallback((s: FlyState) => setFly(s), []);
  const onRoomInfo = useCallback((info: RoomInfo | null) => setRoomInfo(info), []);
  const onHealth = useCallback((value: number | null) => setHealth(value), []);
  const onClient = useCallback((value: GameClient | null) => setClient(value), []);

  // Held so the debug panel can write uniform values directly. Not state the scene
  // reads back, so changing a slider never re-renders the canvas tree.
  const [grassUniforms, setGrassUniforms] = useState<GrassUniforms | null>(null);
  const onGrassReady = useCallback((u: GrassUniforms | null) => setGrassUniforms(u), []);
  const [foliageControls, setFoliageControls] = useState<FoliageDebugControls | null>(null);
  const onFoliageDebugReady = useCallback(
    (c: FoliageDebugControls | null) => setFoliageControls(c),
    []
  );
  const [sceneHandles, setSceneHandles] = useState<SceneHandles | null>(null);
  const onSceneReady = useCallback((s: SceneHandles | null) => setSceneHandles(s), []);

  // Publish exact numbers for the benchmark driver rather than making it read the HUD.
  // In an EFFECT, not the render body: written during render it fires twice per commit
  // under StrictMode, and a render that is thrown away would still publish a sample the
  // driver could read as presented. Runs only under ?bench=1.
  useEffect(() => {
    if (!BENCH.enabled || !perf || !fly) return;
    publish({
      ms: perf.ms,
      fps: perf.fps,
      worstMs: perf.worstMs,
      drawCalls: perf.drawCalls,
      triangles: perf.triangles,
      backend: perf.backend,
      dpr: BENCH.dpr ?? 0,
      steps: BENCH.steps ?? 0,
      grass,
      stance,
      agl: fly.agl,
    });
  }, [perf, fly, grass, stance]);
  const onStatus = useCallback(
    (s: { loading: boolean; terrain: LoadedTerrain | null }) => setStatus(s),
    []
  );
  const toggleGround = useCallback(() => setGrounded((g) => !g), []);
  // Choosing a stance means "put me on the ground like this", from the HUD or
  // the keyboard alike.
  const chooseStance = useCallback((s: Stance) => {
    setStance(s);
    setGrounded(true);
  }, []);

  return (
    <>
      {status.loading ? (
        <div className="boot">
          <div>Decoding terrain</div>
          <div className="bar">
            <i />
          </div>
        </div>
      ) : (
        <GameHud
          fly={fly}
          // The one call site `faab73f` said would change when the authority
          // landed. It reaches here from GameClient through usePlayerVitals and
          // DF2Scene, so the HUD still does not know how health is sourced —
          // and it is null offline, where no authority reports hit points.
          health={health}
          feed={feed}
          joinCode={roomInfo?.joinCode ?? null}
          fpsMode={scopeDemo}
          preview={hudPreview}
          panels={hudPanels}
          panelAlpha={panelAlpha}
        />
      )}

      {/* The console is always mountable now, not gated on ?debug=1 — that
          parameter only decides whether it starts OPEN. Gating the mount meant a
          session that had not thought to add the parameter could not reach the
          dials at all without a reload. */}
      {!status.loading && (
        <DevConsole
          state={devConsole}
          terrain={status.terrain}
          perf={perf}
          fly={fly}
          grounded={grounded}
          setGrounded={setGrounded}
          stance={stance}
          setStance={chooseStance}
          grass={grass}
          setGrass={setGrass}
          wireframe={wireframe}
          setWireframe={setWireframe}
          terrainScale={terrainScale}
          setTerrainScale={setTerrainScale}
          networked={netDemo}
          grassUniforms={grassUniforms}
          foliageControls={foliageControls}
          scene={sceneHandles}
          fpsMode={scopeDemo}
          panels={hudPanels}
          setPanel={setHudPanel}
          setAllPanels={setAllHudPanels}
          panelAlpha={panelAlpha}
          setPanelAlpha={setPanelAlpha}
        />
      )}

      <GameCanvas>
        <DF2Scene
          wireframe={wireframe}
          grass={grass}
          grounded={grounded}
          stance={stance}
          terrainScale={terrainScale}
          onStatus={onStatus}
          onPerf={onPerf}
          onFly={onFly}
          onRoomInfo={onRoomInfo}
          onHealth={onHealth}
          onClient={onClient}
          onToggleGround={toggleGround}
          onStance={chooseStance}
          onGrassReady={onGrassReady}
          onFoliageDebugReady={onFoliageDebugReady}
          onSceneReady={onSceneReady}
          scopeDemo={scopeDemo}
          weaponDemo={weaponDemo}
          motorDemo={motorDemo}
          netDemo={netDemo}
        />
      </GameCanvas>
    </>
  );
}
