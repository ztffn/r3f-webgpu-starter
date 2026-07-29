import { useCallback, useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { Hud } from "./components/Hud";
import { DF2Scene } from "./df2/DF2Scene";
import type { FlyState, Stance } from "./df2/FlyControls";
import type { LoadedTerrain } from "./df2/loadTerrain";
import type { PerfSample } from "./df2/PerfMonitor";

export default function App() {
  const [wireframe, setWireframe] = useState(false);
  const [grass, setGrass] = useState(true);
  const [grounded, setGrounded] = useState(false);
  const [stance, setStance] = useState<Stance>("stand");

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
        />
      </GameCanvas>
    </>
  );
}
