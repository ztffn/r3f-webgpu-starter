export function Overlay({ wireframe, setWireframe }) {
  return (
    <div className="overlay">
      <header>
        <h1>
          DELTA FORCE <span>2</span>
        </h1>
        <p>
          Web port — Phase 1 terrain scaffold. Chunked LOD heightfield on
          Three.js WebGPU + TSL, running on synthetic fBm terrain. Drag to orbit,
          right-drag to pan, scroll to zoom.
        </p>
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
          Reconstruction of NovaLogic's Voxel Space 32 terrain — see{" "}
          <span>/docs</span>
        </p>
      </footer>
    </div>
  );
}
