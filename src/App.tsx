import { useCallback, useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { Hud } from "./components/Hud";
import { GrassDebug } from "./components/GrassDebug";
import { DF2Scene } from "./df2/DF2Scene";
import type { GrassUniforms } from "./df2/GrassMaterial";
import type { FlyState, Stance } from "./df2/FlyControls";
import type { LoadedTerrain } from "./df2/loadTerrain";
import type { PerfSample } from "./df2/PerfMonitor";
import { BENCH, publish } from "./df2/bench";

const requestedScene = new URLSearchParams(window.location.search).get("scene");
const scopeDemo = requestedScene === "scope";
const weaponDemo = requestedScene === "weapon";

export default function App() {
  const [wireframe, setWireframe] = useState(false);
  const [grass, setGrass] = useState(BENCH.grass ?? true);
  // ?bench=1 always starts on foot: the ground-level frame is the one being tuned.
  const [grounded, setGrounded] = useState(BENCH.enabled || scopeDemo || weaponDemo);
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

  // Publish exact numbers for the benchmark driver rather than making it read the
  // HUD. Kept out of the render path; runs only under ?bench=1.
  if (BENCH.enabled && perf && fly) {
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
  }
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
      <Hud
        loading={status.loading}
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
      />

      {BENCH.debug && !status.loading && <GrassDebug uniforms={grassUniforms} />}

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
          scopeDemo={scopeDemo}
          weaponDemo={weaponDemo}
        />
      </GameCanvas>
    </>
  );
}
