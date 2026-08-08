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

## It waits for the world to FINISH BUILDING, not for numbers to stop moving

Stability is not completion. Chunk building is budgeted per FRAME, so at one frame per
second it advances about 6 ms per SECOND: a draw-call count can sit unchanged for ten
seconds with a third of the chunk window still missing. Two comparisons were wrong before
this was understood — one pass reported 25 draw calls against another run's 103 for the
same scene, and a grass-on/grass-off pair read 175 against 244, i.e. grass appearing to
*reduce* draw calls, which is impossible.

The builders now publish their own completion signals — `window.__terrain.pendingChunks`
and `window.__foliage.pendingBuckets` — and this rig waits for both to reach zero. The same
grass comparison then reads 274 against 244, with grass adding 212k triangles.

`settled: false` in the output means the deadline expired with work outstanding. Do not
compare those numbers to anything.

Frame times still do not reproduce here and never will: the same configuration reorders
freely run to run, and a settled frame costs ~800 ms with vegetation and grass both switched
OFF. Quote the counts; ignore the milliseconds.

## Vantage matters more than you would think

`?x=5&z=375` — the grass bench vantage — has an **openness of 0.15**: 85% of that view is
hillside above eye level, and only 15 plants and 4 trees are on screen. It is a bad place to
photograph vegetation and a fine place to measure grass. For vegetation use:

```
?bench=1&canopyall=0&foliage=1&stance=stand&x=512&z=576&yaw=3.142&pitch=-0.12
```

`canopyall=0` matters: `?bench=1` forces the grass canopy to full height everywhere, which
buries scrub and half-buries bushes.

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
