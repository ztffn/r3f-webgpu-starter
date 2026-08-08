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

This first stage is deliberately lossless apart from Meshopt packing. Runtime integration
adds three explicit stages — the first two exist now (2026-08-07):

1. **DONE — `extract-prototypes.mjs`**: pairs trunk and branch nodes by co-location, bakes
   transforms, normalises each tree to UNIT height with its base at the origin, converts
   leaf materials from BLEND to MASK, and writes `prototypes/prototypes.glb` (trunk and
   leaf primitives split per tree, textures deduped, base colour only) plus a manifest
   with attribution and the unit-space crown/trunk measurements a species record needs.
   The stage-1 whole-pack runtime GLB is NOT committed — this output is.
2. **DONE — impostor atlases**: `bake-impostors.mjs` bakes prototype species from the same
   GLB (textured mode: colour from the pack's own textures, sRGB-linearised; note the pack
   authors leaf uvs in v ∈ [1,2] and relies on REPEAT wrap — a clamping sampler bakes every
   crown to nothing). Geometric LODs beyond the authored mesh are still unauthored; at
   ~600 triangles per tree nothing needs them yet.

   **Output is KTX2 (UASTC + Zstd), not PNG**, since 2026-08-08. `ktx2.mjs` owns the encode
   and the audit. Requires **KTX-Software on PATH** (`toktx` and `ktx`; `brew install ktx`) —
   the bake fails loudly without it. Three rules that are not negotiable:
   - Never `--genmipmap`. Levels are supplied explicitly; the encoder's box filter over alpha
     undoes the coverage solve in `alphaMips.ts`.
   - Albedo uses `buildCoveragePreservingMips`; normal uses `weightedNormalMips`. Swapping
     them rescales the depth channel and brightens the whole far ring.
   - The audit decodes the SHIPPED file and throws if coverage drops more than 0.005. Do not
     move it back onto the source — that is how the authored trees ended up unaudited.

   Format was chosen by measurement, not preference: ETC1S flips 0.569% of pixels across the
   runtime alpha cutoff and thins the silhouette; UASTC flips 0.000%. Raw UASTC without
   `--zcmp` is an 18x download regression. Numbers and method in plan v2 §5.4d.

   **Reusable for the asset pipeline:** `ktx2.mjs` takes any mip-level array, so authored
   prop and vehicle textures can go through the same encode and the same shipped-artefact
   audit. Keep one path — three copies of the glTF flattening loop already exist across
   `bake-impostors.mjs`, `extract-prototypes.mjs` and `prepare-vegetation.mjs`, and
   consolidating them is scoped with the asset-authoring work.
3. map logical species to collider records and add parity tests comparing analytic trunk hits
   with the expected cylinder bounds. (`species.ts` carries the records, pinned to the
   extraction manifest by `tests/foliage/species-prototypes.test.ts`; the ray-parity tests
   remain open.)

Source license and attribution are copied into the manifest from the GLB's asset metadata; do
not publish a processed pack without retaining those credits.
