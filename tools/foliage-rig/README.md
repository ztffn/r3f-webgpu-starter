# foliage-rig

Headless smoke test and counter reader for the vegetation layer (`src/foliage/`).

Its job is **not** frame time. This container, and any CI runner, has no GPU: three falls
back to WebGL2 on SwiftShader and every millisecond it reports is software-rasteriser CPU
time (`docs/08` §10). What it does give you, exactly:

- **whether the TSL graph compiles at all** — a broken node graph fails loudly here and is
  otherwise only discoverable by opening the app on a machine with a GPU;
- **draw calls and triangles**, which are exact on any backend;
- **instance, bucket and cell counts** from `window.__foliage`;
- **alpha occupancy and per-mip coverage** of the leaf texture.

## Run

```sh
npm run build
npx vite preview --port 4183 --host 127.0.0.1 &

# playwright-core is not a project dependency (same as tools/grass-rig)
npm i --no-save playwright-core

CHROME_PATH=/path/to/chrome node tools/foliage-rig/smoke.mjs \
  "http://127.0.0.1:4183/?bench=1&foliage=1&dpr=0.5&stance=stand&x=5&z=375" shot.png
```

## It waits for the counts to SETTLE, and that matters

Terrain chunk building and foliage cell building are both budgeted per frame, so the first
few seconds report a half-built world. An earlier version of this script sampled as soon
as the foliage counters appeared and produced draw-call numbers that varied by 6x between
runs of the same configuration — comparisons drawn from them would have been noise. It now
polls until the draw-call count stops moving and no bucket is still pending.

## Knobs worth sweeping

| Parameter | Meaning |
|---|---|
| `foliage=1` | draw the layer at all — everything else is inert without it |
| `foliagevariant=A\|B\|C\|D` | card construction (see `foliageGeometry.ts`) |
| `foliagealpha=mask\|a2c\|hash\|blend` | alpha handling |
| `foliagecell=<m>` | cell side; the draw-call vs culling-granularity dial |
| `foliageradius=<m>` | window reach, held constant while sweeping cell size |
| `foliagedensity=<x>` | global density multiplier |

`foliageradius` is in METRES on purpose. Expressed in cells it moved with `foliagecell`,
so a cell sweep changed the reach at the same time and its numbers meant nothing.
