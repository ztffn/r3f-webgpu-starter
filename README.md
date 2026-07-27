# Delta Force 2 — Web Port

A browser-based reconstruction of **Delta Force 2** (NovaLogic, 1999), focused on
faithfully reproducing its two defining technical traits: the **Voxel Space 32** heightfield
terrain and its signature concealing **tall grass**. Built on **Three.js `WebGPURenderer`**
with **TSL** shaders and **React Three Fiber** (forked from a WebGPU R3F starter).

This is a hobby/reconstruction project, not a commercial release.

## Status

**Phase 1 — chunked/LOD terrain scaffold — is in.** It runs on synthetic fBm terrain (no
game assets required):

- Chunked heightfield mesh with real distance-based per-chunk LOD and a geometry cache.
- Edge "skirts" to hide cracks between differing-LOD chunks.
- Analytic normals from the heightfield gradient → stable lighting across LOD levels.
- A TSL terrain material blending sand/grass/rock/snow biomes by height and slope.
- Sun + hemisphere lighting, distance fog, and a water plane.
- Map-style camera (orbit / pan / zoom) and a wireframe toggle.

The CPU-side heightfield (`src/df2/Heightfield.js`) is deliberately decoupled from the render
mesh so it can later serve as the gameplay/concealment field without a rewrite.

See [`docs/`](./docs) for the full design:

| Doc | Topic |
| --- | --- |
| [`01`](./docs/01-project-overview-and-roadmap.md) | Project overview & phased roadmap |
| [`02`](./docs/02-asset-format-specification.md) | PFF/TGA/PCX/`.3DI` asset formats |
| [`03`](./docs/03-terrain-and-grass-rendering-design.md) | Terrain & grass rendering design |
| [`04`](./docs/04-concealment-system-design.md) | Concealment / line-of-sight system |
| [`05`](./docs/05-engine-architecture-tech-stack.md) | Engine architecture & tech stack |

## Source layout

```
src/df2/
  config.js          world constants (size, chunking, LOD, height/fog/water)
  noise.js           deterministic value noise + fBm
  Heightfield.js     CPU heightfield: bilinear sample() + analytic normal()
  terrainGeometry.js per-chunk BufferGeometry (grid + skirt)
  TerrainMaterial.js TSL biome material
  Terrain.js         chunk grid + per-frame LOD selection
  DF2Scene.js        scene composition (lights, fog, water, camera)
src/components/
  GameCanvas.js      WebGPU + R3F canvas bootstrap
  Overlay.js         UI overlay
```

## Getting started

Install [Node.js](https://nodejs.org/en/download/), then:

```shell
npm install
npm start      # dev server at localhost:3000
npm run build  # production build
```

A WebGPU-capable browser is recommended; Three.js falls back to WebGL2 automatically where
WebGPU is unavailable.

## Roadmap (next)

- **Phase 0** — `df2-extract` asset pipeline (PFF3 unpack, TGA/PCX→PNG, `.3DI`→glTF).
- **Phase 2** — grass: relief-mapped far field + compute-instanced near-field blades.
- **Phase 3** — concealment / line-of-sight against a decoupled gameplay heightfield.
- **Phase 4** — swap synthetic data for real extracted terrain; controller, physics, AI.

## Credits

The WebGPU + R3F canvas bootstrap is derived from Anderson Mancini's
[r3f-webgpu-starter](https://github.com/ektogamat/r3f-webgpu-starter).
