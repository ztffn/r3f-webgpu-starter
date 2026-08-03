# Vegetation preprocessing

`prepare-vegetation.mjs` is the offline ingest step for downloaded vegetation GLBs. It does
not run in Vite, React, the browser, Rapier, or the authoritative projectile loop.

```sh
npm run prepare:vegetation
npm run prepare:vegetation -- \
  --input _tempAssets/3d/_Vegetation/low_poly_rocks_and_trees.glb \
  --output /tmp/vegetation-runtime
npm run validate:vegetation -- /tmp/vegetation-runtime/vegetation-manifest.json
```

The default input is `_tempAssets/3d/_Vegetation/`; every GLB in that directory is inspected.
The default output is `public/assets/vegetation/` and contains:

- one Meshopt-compressed runtime GLB per source pack;
- `vegetation-manifest.json`, containing source attribution, geometry statistics, logical
  prototype candidates, bounds, and proposed gameplay collider records.

The source packs are intentionally not split into one runtime file per mesh. The source
scenes contain sample layouts, repeated bush instances, and Sketchfab export transforms. A
later runtime adapter will select logical prototypes from the manifest and feed normalized
geometry templates into the foliage branch's existing cell-local `InstancedMesh` buckets.

## Collider contract

The manifest emits suggestions only for tree trunks/bark and rocks:

- trees → analytic vertical cylinders, `wood` surface;
- rocks → optional boxes, `stone` surface;
- leaves, grass, flowers, and bushes → no bullet collider.

The collider record is independent of visual LOD and must be reviewed against species/gameplay
balance before being enabled. The authoritative bullet path should consume these records through
the renderer-independent `WorldQuery` seam. The PR #8 Rapier character representation remains
separate; vegetation should not become one Rapier body per plant.

## Next stages

This first stage is deliberately lossless apart from Meshopt packing. Runtime integration will
add three explicit stages:

1. normalize/pivot each selected prefab and deduplicate repeated source layout nodes;
2. author or generate near/mid geometry LODs and an impostor atlas (the existing foliage
   renderer already supplies the card/impostor policy);
3. map logical species to collider records and add parity tests comparing analytic trunk hits
   with the expected cylinder bounds.

Source license and attribution are copied into the manifest from the GLB's asset metadata; do
not publish a processed pack without retaining those credits.
