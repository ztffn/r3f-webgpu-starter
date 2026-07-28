import type { LoadedTerrain } from "../df2/loadTerrain";
import type { PerfSample } from "../df2/PerfMonitor";

export interface OverlayProps {
  wireframe: boolean;
  setWireframe: (v: boolean) => void;
  loading: boolean;
  terrain: LoadedTerrain | null;
  perf?: PerfSample | null;
}

export function Overlay({ wireframe, setWireframe, loading, terrain, perf }: OverlayProps) {
  const subtitle = loading
    ? "Loading terrain…"
    : terrain
      ? `${terrain.name} — terrain by ${terrain.creator}. Real DF-era heightmap and colormap (${terrain.size}×${terrain.size}), chunked LOD on WebGPU + TSL.`
      : "No extracted terrain found — running synthetic fBm terrain. See tools/df2-extract to prepare a real map.";

  return (
    <div className="overlay">
      {perf && (
        <div className="perf">
          <span className="perf-fps">{perf.fps.toFixed(0)} fps</span>
          <span>{perf.ms.toFixed(1)} ms</span>
          <span>peak {perf.worstMs.toFixed(1)} ms</span>
          <span>{perf.drawCalls} calls</span>
          <span>{(perf.triangles / 1000).toFixed(0)}k tris</span>
        </div>
      )}
      <header>
        <h1>
          DELTA FORCE <span>2</span>
        </h1>
        <p>{subtitle}</p>
      </header>
      <footer>
        <div className="footer-buttons">
          <button className="toggle" onClick={() => setWireframe(!wireframe)}>
            {wireframe ? "Solid" : "Wireframe"}
          </button>
          <button
            className="toggle"
            onClick={() =>
              window.open(
                "https://github.com/ztffn/r3f-webgpu-starter",
                "_blank",
                "noreferrer"
              )
            }
          >
            Source
          </button>
        </div>
        <p className="footer-text">
          Drag to orbit · right-drag to pan · scroll to zoom
        </p>
      </footer>
    </div>
  );
}
