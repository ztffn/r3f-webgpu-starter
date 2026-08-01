# grass-rig

Headless harness for the columnar grass shader. Renders a fixed vantage, dumps
the canvas, and scores it — a config is testable in ~1.5 s instead of minutes
through the full app.

It exists because eyeballing kept passing builds that were measurably wrong, and
because two "matching" scores turned out to be measuring bare terrain.

## Run

```sh
npm install                 # from the repo root
cd tools/grass-rig
ln -s ../../node_modules node_modules
cp -r ../../public/assets assets      # prepared terrain (committed; copied so the rig serves it)
npx vite build
python3 -m http.server 4180 --bind 127.0.0.1 &
node drive.mjs '[{"name":"shot","camX":672,"camZ":288,"yaw":2.2,"pitch":0,"fov":65,
  "eye":1.7,"grass":true,"grassScale":0.0047,"steps":96,"cellSize":0.03,
  "toneVariation":0.85,"nearClip":1.2,
  "target":{"distance":50,"stance":"prone"}}]' .
```

## What it gives you

- **Range/concealment scenario** — a green capsule stands in for a player at a
  set distance and stance (`stand` / `prone`), with a scoped picture-in-picture
  inset so naked-eye and 10x views are comparable in one frame.
- **Auto-bearing** — picks a sightline where the target is NOT skylined. Aiming
  down an arbitrary bearing tends to put the capsule on a ridge against open sky
  with no canopy in between, which makes concealment look broken when only the
  sightline was wrong. This cost a false "concealment is broken" conclusion once.
- **Depth probe** (`probe: <metres>`) — sphere on the ground plus a tall pole, to
  check grass depth-sorts against polygonal objects.
- **Metrics** (`metric.py`) — |dx| / |dy| and directional autocorrelation, the
  measures the reference screenshots are scored on (docs/07 §5). Score GRASS
  PIXELS ONLY; whole-crop numbers are dominated by bare terrain. The mask used to
  come from a `debugHit` rig option, which no longer exists — the material's debug
  views are driven by the `debugMode` uniform now, so a rig run wanting the mask has
  to set that on the returned `uniforms` (view 1 is the hit mask).

## Caveat

This environment is software-rasterised, so `perf.mjs` frame times are CPU
submission, not GPU. Draw-call and triangle counts are exact; frame time is not.
