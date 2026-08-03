# Vegetation assets and authoritative ballistic colliders

**Status:** engineering reference for the offline vegetation pipeline and its planned
integration with FPS gunplay.

**Audience:** anyone changing vegetation rendering, asset preparation, `WorldQuery`, bullet
penetration, or the shared character/motor physics.

This document connects three systems that must remain separate:

1. authored vegetation assets and their render LODs;
2. renderer-independent vegetation records used by bullet queries;
3. Rapier terrain collision used by the shared character motor.

The current vegetation preparation tool is
[`tools/vegetation/prepare-vegetation.mjs`](../tools/vegetation/prepare-vegetation.mjs).
The incoming character/multiplayer work is tracked in [PR #8](https://github.com/ztffn/r3f-webgpu-starter/pull/8).

## 1. The boundary

The GLB is an art source. It is never authoritative gameplay geometry.

```text
source GLB
  -> offline normalization, deduplication, packing, attribution
  -> runtime render prototypes
  -> cell-local InstancedMesh buckets + visual LOD/impostor

source GLB metadata + authored species policy
  -> renderer-independent vegetation manifest
  -> deterministic placement records
  -> analytic trunk/cover query
  -> CompositeWorldQuery -> ballistic penetration

terrain height source
  -> HeightfieldWorldQuery              (bullets)
  -> TerrainCollider / StaticTerrainCollider (Rapier character motor)
```

A visual LOD change must not alter whether a bullet hits a trunk, how much material it
penetrates, or whether the motor can stand on the terrain. The render scene, GLTF nodes,
grass shells, camera caps, foliage impostors, and terrain LOD meshes are not bullet or motor
collision inputs.

## 2. Offline preparation tool

Run the pipeline with:

```sh
npm run prepare:vegetation
npm run prepare:vegetation -- \
  --input _tempAssets/3d/_Vegetation/low_poly_rocks_and_trees.glb \
  --output /tmp/vegetation-runtime
npm run validate:vegetation -- /tmp/vegetation-runtime/vegetation-manifest.json
```

The default input directory is `_tempAssets/3d/_Vegetation/`; every GLB there is processed.
The default output is `public/assets/vegetation/`.

The tool currently:

- reads GLB files with glTF Transform;
- preserves embedded source attribution and license metadata;
- records mesh/node names, vertex and triangle counts, transformed bounds, and semantic kind;
- deduplicates and prunes unused glTF data;
- writes one Meshopt-compressed runtime GLB per source pack;
- writes `vegetation-manifest.json` containing render candidates and collider proposals;
- validates unique IDs, source attribution, finite dimensions, and collider thickness.

The tool deliberately does not run in Vite, React, Three.js, Rapier, or the projectile loop.
Meshopt is used for geometry packing; texture compression and KTX2 delivery remain a later
asset-size stage because the source packs are texture-heavy.

The current local run processes three packs:

| source | triangles | packed output |
|---|---:|---:|
| `low_poly_forest_tree_pack.glb` | 3,747 | ~9.5 MiB |
| `low_poly_rocks_and_trees.glb` | 10,984 | ~21.6 MiB |
| `plants_asset_set.glb` | 94,850 | ~9.1 MiB |

The last pack is substantially heavier and should not be admitted to dense foliage placement
without a separate decimation/selection pass.

## 3. Runtime object model

The runtime unit is a logical prefab, not a source mesh file and not an individual scene node.
Expected logical groups are:

| logical prefab | render representation | gameplay representation |
|---|---|---|
| tree | trunk + canopy templates, instanced per cell | analytic vertical trunk cylinder |
| shrub/bush | card or authored low-poly template, instanced per cell | no bullet collider by default |
| grass/flower | existing grass/card layer | no bullet collider |
| decorative rock | instanced opaque mesh or authored cluster | optional static box cover |

The remote foliage renderer already provides the important render mechanics: cell-local
`InstancedMesh` buckets, four visual levels (three geometry levels plus an impostor), LOD
hysteresis, and geometry-pointer swaps without moving instance data. Imported GLB geometry
should become templates consumed by that renderer; it should not reintroduce one `Object3D`
per plant.

The source scene layout is not a prefab layout. Sketchfab exports contain sample placement
nodes, repeated bush samples, and scale/axis transforms. The next asset stage must:

1. bake node transforms into selected geometry;
2. convert and verify the project’s Y-up/world-scale convention;
3. remove sample-scene translations;
4. place each prefab origin at its ground contact;
5. pair trunk and canopy variants explicitly;
6. generate/import near and mid LOD templates;
7. generate an impostor atlas or use the existing foliage card impostor path.

Separate trunk and canopy materials may cost separate instanced draws. Combining them into one
custom material is an optimization to measure, not a prerequisite for correctness.

## 4. Manifest and deterministic placement

The manifest is data-only. A future runtime/shared loader should expose records similar to:

```ts
interface VegetationColliderRecord {
  readonly shape: "cylinder" | "box";
  readonly radiusMetres?: number;
  readonly heightMetres?: number;
  readonly sizeMetres?: readonly [number, number, number];
  readonly surfaceId: "wood" | "stone";
  readonly penetrationThicknessMetres: number;
}
```

The deterministic vegetation field selects a species and transform from world-cell coordinates
and a stable seed. The render bucket and the analytic query consume the same record. The GLB is
not loaded by the server and is not needed to answer a bullet query.

The current generated collider values are **proposals**. They are derived from transformed
source bounds and include a review marker because visual bounds are not automatically good
gameplay thickness. Species balance must author the final radius, height, surface, and
penetration thickness. Decorative rocks should not all become cover just because they have
triangles.

## 5. Bullet query and penetration

The FPS combat contract is:

```text
BallisticProjectileSystem (fixed 120 Hz)
  -> swept WorldQuery segment
  -> nearest terrain / collider hit
  -> surface resistance + thickness + incidence
  -> penetrate or stop
  -> impact/penetration event and continued projectile
```

`CompositeWorldQuery` returns the nearest result from:

- `HeightfieldWorldQuery`, which intersects the canonical CPU heightfield analytically;
- `ThreeWorldQuery`, which indexes explicitly registered simplified colliders in 32 m X/Z
  cells and uses Three.js only for narrow-phase tests.

Vegetation should normally be added as an analytic source alongside the terrain query, rather
than registering thousands of visual meshes. This is the pattern used by the foliage branch's
`VegetationWorldQuery`: walk candidate vegetation cells, intersect a vertical trunk cylinder,
and return the nearest hit with a stable vegetation ID.

The penetration system then uses the collider’s authored `surfaceId` and
`penetrationThicknessMetres`. Material names, alpha coverage, render LOD, leaf density, and
impostor state must never determine penetration. A penetrating round loses energy, emits
entry/exit data, advances slightly beyond the simplified collider, and continues within the
bounded projectile interaction budget.

Recommended defaults:

- tree trunks: `wood`, analytic cylinder, thickness tuned per species;
- rocks used as cover: `stone`, box or conservative convex proxy;
- leaves, grass, flowers, and shrubs: no ballistic obstruction;
- concealment: a separate gameplay query, not a fake bullet collider.

This makes a bush able to conceal without arbitrarily stopping rifle rounds, while a trunk can
provide a measurable wood penetration event.

## 6. Rapier motor and physics separation

PR #8 adds a shared fixed-60-Hz character motor over Rapier. Its important contracts are:

- `src/motor/` and `src/net/` must remain free of runtime Three.js and React imports;
- `MotorRoom` owns one shared Rapier world step for all motors;
- clients may use a recentering `TerrainCollider` window;
- a server room should use one shared `StaticTerrainCollider` for its region;
- terrain collider samples use the same height source with a measured subdivision policy;
- the Rapier terrain representation and bullet `CompositeWorldQuery` representation coexist
  intentionally and are not expected to be the same shape.

Vegetation therefore does **not** go into the motor’s Rapier world by default. A forest tree is
not a character-floor surface, and adding one body per plant would destroy the shared-world
cost model. If a future design requires the motor to collide with a small number of large,
walk-blocking trunks or rock formations, those should be a separately authored, spatially
bounded Rapier obstacle set. They must not be inferred from every render instance.

The server authority can consume the same vegetation manifest and deterministic placement data
for bullet queries without loading GLB files. The browser can load the packed GLB for visuals;
the authoritative path should operate on JSON/typed data only.

## 7. Required follow-up stages

Before vegetation affects gunplay or ships as runtime content:

1. normalize and extract logical prefab templates from the optimized packs;
2. add texture resizing/KTX2 or another measured delivery format;
3. author imported LOD0/LOD1/LOD2 geometry and connect LOD3 to the card/impostor path;
4. replace bounds-derived collider proposals with reviewed species records;
5. implement the shared analytic vegetation source for `CompositeWorldQuery`;
6. add parity tests for cylinder hits, cell traversal, nearest-hit ordering, and penetration;
7. add a separate small Rapier obstacle fixture only if character blocking is required;
8. benchmark draw calls, visible instances, bullet candidate counts, and penetration load
   independently on WebGPU and WebGL2.

The acceptance rule is that changing render density, cell size, LOD, alpha mode, texture, or
impostor policy does not change authoritative bullet outcomes.

