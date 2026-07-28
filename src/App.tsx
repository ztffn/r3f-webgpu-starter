import { useCallback, useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { Overlay } from "./components/Overlay";
import { DF2Scene } from "./df2/DF2Scene";
import type { LoadedTerrain } from "./df2/loadTerrain";

export default function App() {
  const [wireframe, setWireframe] = useState(false);
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
      />

      <GameCanvas>
        <DF2Scene wireframe={wireframe} onStatus={onStatus} />
      </GameCanvas>
    </>
  );
}
