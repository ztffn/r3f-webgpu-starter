// The playable scene — everything below this module pulls in Three.js.
//
// Reached only through a dynamic import from the /play route (src/site/routes.tsx),
// which is what keeps ~1.5 MB of renderer off the landing page. Nothing in
// src/site/ or src/ui/ may import this file or anything it imports; the boundary
// is invisible until something crosses it and then it costs megabytes.

import { useCallback, useEffect, useState } from "react";
import "../styles.css";
import { GameCanvas } from "../components/GameCanvas";
import { GameHud } from "../hud/GameHud";
import { DevConsole } from "../devtools/DevConsole";
import { useDevConsole } from "../devtools/useDevConsole";
import { DF2Scene, type SceneHandles } from "../df2/DF2Scene";
import type { GrassUniforms } from "../df2/GrassMaterial";
import type { FlyState, Stance } from "../df2/FlyControls";
import type { LoadedTerrain } from "../df2/loadTerrain";
import type { PerfSample } from "../df2/PerfMonitor";
import { BENCH, publish } from "../df2/bench";

const urlParams = new URLSearchParams(window.location.search);
const requestedScene = urlParams.get("scene");
const scopeDemo = requestedScene === "scope";
const weaponDemo = requestedScene === "weapon";
/**
 * Walk the shared character motor instead of the terrain spike's camera rig.
 *
 * Orthogonal to the scene on purpose: `?scene=motor` is movement alone, and
 * `?scene=scope&motor=1` is the combination that matters — a weapon carried by
 * a body that actually collides, so stance, speed and being airborne reach
 * weapon handling instead of being inferred from the camera.
 */
const motorDemo = requestedScene === "motor" || urlParams.get("motor") === "1";
/**
 * Networked play: the motor predicts against the authoritative game server and
 * remote players appear in the world. `?scene=scope&motor=1&net=1`, with an
 * optional `server=` URL override (default ws://localhost:2567). Requires the
 * motor — there is nothing to network without it.
 */
const netDemo = motorDemo && urlParams.get("net") === "1";
/**
 * Render the HUD panels that have no data source yet — objective and squad chat.
 *
 * They exist so the redesign can be compared 1:1 against
 * `design/df2-hud-1to1-html-v3`, and they are OFF by default because a scripted
 * objective that nothing will ever update is a lie a player would believe.
 */
const hudPreview = urlParams.get("hudpreview") === "1";

export default function GameApp() {
  // The game owns the viewport and must never scroll; the site must. Set as a
  // body class rather than a global stylesheet rule because this module's CSS is
  // injected on first visit and never removed — a global `overflow: hidden` left
  // every site page unscrollable for the rest of the session.
  useEffect(() => {
    document.body.classList.add("mode-game");
    return () => document.body.classList.remove("mode-game");
  }, []);

  // `?debug=1` starts it open; backtick toggles it either way.
  const devConsole = useDevConsole(BENCH.debug === true);

  const [wireframe, setWireframe] = useState(false);
  const [grass, setGrass] = useState(BENCH.grass ?? true);
  // ?bench=1 always starts on foot: the ground-level frame is the one being tuned.
  // The motor is always on foot — it has no fly mode to toggle out of.
  const [grounded, setGrounded] = useState(
    BENCH.enabled || scopeDemo || weaponDemo || motorDemo
  );
  const [stance, setStance] = useState<Stance>(BENCH.stance ?? "stand");

  const [perf, setPerf] = useState<PerfSample | null>(null);
  const [fly, setFly] = useState<FlyState | null>(null);
  const [status, setStatus] = useState<{ loading: boolean; terrain: LoadedTerrain | null }>({
    loading: true,
    terrain: null,
  });

  // The scene reports through callbacks rather than owning this state, so the
  // HUD can re-render on telemetry without ever re-rendering the canvas tree.
  const onPerf = useCallback((s: PerfSample) => setPerf(s), []);
  const onFly = useCallback((s: FlyState) => setFly(s), []);

  // Held so the debug panel can write uniform values directly. Not state the scene
  // reads back, so changing a slider never re-renders the canvas tree.
  const [grassUniforms, setGrassUniforms] = useState<GrassUniforms | null>(null);
  const onGrassReady = useCallback((u: GrassUniforms | null) => setGrassUniforms(u), []);
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
          // Null until server-authoritative damage lands and publishes the
          // local player's hit points; VitalsPanel shows that as an empty
          // dashed track rather than a full bar.
          health={null}
          fpsMode={scopeDemo}
          preview={hudPreview}
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
          grassUniforms={grassUniforms}
          scene={sceneHandles}
          fpsMode={scopeDemo}
        />
      )}

      <GameCanvas>
        <DF2Scene
          wireframe={wireframe}
          grass={grass}
          grounded={grounded}
          stance={stance}
          onStatus={onStatus}
          onPerf={onPerf}
          onFly={onFly}
          onToggleGround={toggleGround}
          onStance={chooseStance}
          onGrassReady={onGrassReady}
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
