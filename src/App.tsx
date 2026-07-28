import { useCallback, useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { Overlay } from "./components/Overlay";
import { DF2Scene } from "./df2/DF2Scene";
import type { LoadedTerrain } from "./df2/loadTerrain";
import type { PerfSample } from "./df2/PerfMonitor";

export default function App() {
  const [wireframe, setWireframe] = useState(false);
  const [perf, setPerf] = useState<PerfSample | null>(null);
  const onPerf = useCallback((s: PerfSample) => setPerf(s), []);
  const [status, setStatus] = useState<{ loading: boolean; terrain: LoadedTerrain | null }>({
    loading: true,
    terrain: null,
  });

  const onStatus = useCallback(
    (s: { loading: boolean; terrain: LoadedTerrain | null }) => setStatus(s),
    []
  );

  return (
    <>
      <Overlay
        wireframe={wireframe}
        setWireframe={setWireframe}
        loading={status.loading}
        terrain={status.terrain}
        perf={perf}
      />

      <GameCanvas>
        <DF2Scene wireframe={wireframe} onStatus={onStatus} onPerf={onPerf} />
      </GameCanvas>
    </>
  );
}
