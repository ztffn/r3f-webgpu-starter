# Lit surfaces, placed scenery, and the foliage layer

> **SUPERSEDED by `2026-08-07-foliage-and-scenery-plan-v2.md`.** This record was written
> before anything had been measured on a GPU, and the measurements changed the ORDER of the
> work, not just its confidence. Its §4 (the legacy/new producer split and the shared
> prototype manifest) still stands and v2 refers back to it; everything about sequencing,
> and its §2 description of the atmosphere seam, is out of date.

Plan for the branch that joins three things which turned out to be one: the post-lighting
atmosphere term (`docs/08` §8 invariant 7's known-open half), the vegetation runtime that
sat unmerged on `claude/foliage-rendering-research-jtr43e` since 2026-08-02, and the
converted DF2 props that arrive from `tools/df2-extract` with no atmosphere, no instancing
and no material response.

Written after rebasing that branch onto main, so section 1 records what the rebase found
rather than what it was expected to find.

Companion records: `2026-08-02-foliage-vegetation-design.md` (the vegetation design, on this
branch), `2026-08-07-asset-material-upgrade-plan.md` (roughness/normals/relief — this plan
delivers its §0 prerequisite and nothing else of it), `2026-08-07-converter-known-gaps.md`
§6 (the lighting half that landed, and the fog half that did not), and `docs/00` for the
test any aesthetic call has to pass.

---

## 0. The one-paragraph version

`atmosphere.shade` attaches to `colorNode`, which is correct only for unlit materials. Every
lit surface in the project therefore renders with three's automatic linear scene fog — a
constant colour — while terrain and grass fade to the sky cubemap sampled along the view ray.
Two fogs in one scene. The fix is one call that installs the same grade-then-fog term on a
node material's OUTPUT, after lighting. It is the gating piece for the whole asset phase, and
the foliage layer is the first consumer with enough lit surface at enough distances to tune it
against. Placed scenery — legacy DF2 props and new vegetation alike — then shares one
instanced renderer, one analytic collider query and one prototype manifest, with two
PRODUCERS either side of a provenance split.

## 1. What the rebase found

Nine commits now sit on main. Four conflicts, all mechanical: `package.json` (main's test
glob already covered the new directory), `bench.ts` (main had grown an `ungated` object that
is a better version of what the branch hand-rolled, so the six foliage parameters joined it),
`DF2Scene.tsx` (both sides wanted), and `WorldQuery.ts` (the branch's source list plus main's
shooter exclusion).

Three things needed adapting to drift, all from the query contract being split into a
Three-free `src/combat/` half for the server AFTER this branch was written:

1. `species.ts` imported `../fps/combat/SurfaceProfile.ts`, which moved to `src/combat/`.
2. `WorldHit` gained a required `objectName`. Vegetation reports the shared trunk proxy's
   name; `objectId` is still the identity, and still the deterministic position-free one.
3. **A composed source cannot implement the shared `WorldQuery`.** That contract is
   Three-free, so its hit carries no `object`, but every existing browser caller expects one.
   `WorldQuerySource` names the browser-side shape instead. The alternative — widening the
   composite's return — would have cost every caller the intersected object.

`excludeObjectId` is now FORWARDED to sources. A composite that kept it for its own colliders
would make the contract's exclusion silently absent from every source at once.

Verified after: typecheck clean on both configs, 368 tests (334 + 34), bundle builds with
`FoliageLayer` as its own 20 kB chunk and the entry chunk still 117 kB gzipped.

## 2. The seam, and why `colorNode` cannot carry it

`NodeMaterial.setupOutput(builder, outputNode)` runs AFTER `setupLighting()`, which is the only
point where fog and the grade can reach a lit surface — §2.0 has the form that actually works
and the two that did not. It is reached through `atmosphere.litClass(Base)`.

`fog = false` travels WITH it, in the subclass constructor rather than left to the caller.
Three's linear scene fog is still declared for anything on the automatic path, so leaving it on
double-fogs with a different colour. That pairing is exactly the kind of thing invariant 7
exists to make unforgettable, so it is one call and not two things a material must remember.

**The grade goes post-lighting too, deliberately.** It is a global `.trn` look — tint, gamma,
saturation — being simulated per material, so on a lit surface the analogue of "grade the
pre-shaded colormap" is "grade the lit result". Grading albedo and then lighting it would put
lit surfaces on a different curve from the terrain they stand on, which is the seam the whole
module exists to prevent.

### 2.0 What the seam actually took, after two wrong attempts

Both wrong attempts produced the SAME failure, and it is worth knowing because it looks like
nothing:

```
THREE.TSL: Length of parameters exceeds maximum length of function 'vec4()' type.
```

The scene renders BLACK and no line of code looks wrong. Cause: TSL node types resolve during
the BUILD, not when the graph is written, so swizzling a node whose type is not yet known does
not narrow. `output`'s declared type is the literal string `"output"`; `vec4(light, alpha).max(0)`
is a math node whose width a builder has to ask for. Either way `vec4(x.rgb, x.a)` hands `vec4()`
more than four components.

`vec4(output)` first does not fix it. What works is forcing a declared variable and assigning
through a swizzle, which cannot miscount:

```ts
const shaded = vec4(outputNode).toVar();
shaded.rgb.assign(shade(shaded.rgb));
return super.setupOutput(builder, shaded);
```

Wrapped as `atmosphere.litClass(Base)` — a cached subclass per base material class, with `fog`
forced off in its constructor. A subclass rather than an instance-patched method on purpose:
shaded and unshaded materials of the same base are then different classes and cannot share a
compiled pipeline.

**Verified rendering** at `?scene=scope&motor=1&net=1&debug=1&water=40` — terrain built, water
drawing through `litClass`, no TSL error and no pipeline failure in the load's console.

Two process notes worth more than the fix. **The first half of this note was WRONG — see v2 §2.3:**
`?scene=terrain&bench=1` starts the scene and pins the camera fine; the belief that it did not
was a hidden-tab artifact. What holds is that `?bench=1` alone leaves `scene` unset — the
working form is above, and `?water=` is what draws the water plane at all, since every `.trn`
ships `water_height 0`. And the console must be read on a FLUSHED buffer: the reader returns
oldest-first, so a stale error from a previous load reads exactly like a live one, which cost
this session two wrong conclusions in both directions.

### 2.1 Plain materials are the awkward case

GLTFLoader emits plain `MeshStandardMaterial`, `MeshPhysicalMaterial`, or (for
`KHR_materials_unlit`) `MeshBasicMaterial`. None is a node material, so none takes
`outputNode` as written. Three converts them internally via `NodeLibrary.fromMaterial`, which
copies every own enumerable key onto a fresh node material — so assigning `outputNode` to a
plain material happens to work, and is undocumented. Convert explicitly instead, and own the
result so it can be disposed.

Consumers, all of which bypass the atmosphere today:

| Surface | Where | Material |
|---|---|---|
| Water plane | `DF2Scene.tsx` | `MeshStandardNodeMaterial` — already a node material |
| Foliage | `FoliageMaterial.ts` | `MeshStandardNodeMaterial` — already a node material |
| DF2 mission props | `MissionObjects.tsx` | plain, from GLTFLoader |
| Dev-placed objects | `DevPlacedObject.tsx` | plain, from GLTFLoader |
| Soldier | `soldierAssets.ts` | plain, from GLTFLoader |
| Prefab cover/targets | `WorldObjectPrefab.ts` | plain, hand-constructed |

`FlatLit` DF2 materials export as `KHR_materials_unlit` and must take the UNLIT path — the
existing `shade` on `colorNode` — not this one. 5.8% of the corpus.

## 3. Measured: what placed scenery actually costs

Not a level-of-detail problem, which is where the intuition goes first.

| | placements | models | draw calls | triangles |
|---|---|---|---|---|
| warfields | 365 | 40 | 864 | 35k |
| killring | 281 | 10 | 902 | 28k |

Against ~131 draw calls for bare terrain, a mission is roughly seven times the scene's draw
calls for 35k triangles — which is nothing. The converter emits exactly one primitive per
material (22 primitives / 22 materials, 18/18, 15/15: `materialFor` groups by texture-and-flags
pair), and 1999 artists used many such pairs on very little geometry. **Reducing triangles
saves nothing here.**

Instancing does, because the loader already clones one model per placement and clones share
geometry and material:

- warfields: 864 → **230** draw calls (3.8x)
- killring: 902 → **53** draw calls (17x) — one wall segment is placed 195 times

That repetition is the shape of authored 1999 content, so the saving should generalise rather
than being a quirk of two missions.

## 4. The split, and the library

One shared library; two producers either side of a provenance boundary. The split has five
independent justifications, which is why it is a directory boundary and not a flag:

1. **Distribution rights.** Retail-derived conversions are personal-use-only and gitignored;
   community mod assets are committed; third-party packs carry attribution that must survive
   processing. Three different rules about what may ship.
2. **Placement authority.** Mission files place legacy objects at authored coordinates; a
   deterministic field grows new vegetation from a seed. These compose — authored wins where
   it exists — they do not merge.
3. **Material confidence.** DF2 materials carry measured surface-type flag bits; new assets
   carry artist intent. `asset-material-upgrade-plan` §1: do not debug measured and inferred
   together.
4. **Unit scale.** `.3DI` is a calibrated 1/256 m; third-party exports arrive arbitrary.
5. **Opposite optimisations.** Legacy is ~400 triangles over 15–22 materials and wants
   material merging; modern packs are the inverse and want decimation and authored LODs.
   Both transforms in one library gives it two modes and no contract.

### 4.1 The manifest is already most of the contract

`tools/vegetation` emits `df2.vegetation-manifest/v1`, and its prototype record already
carries id, kind, geometry statistics, bounds, and a collider proposal that is **either a
cylinder or a box** — trunks and crates — with `surfaceId` from the shared ballistic
vocabulary. Its validator already refuses a pack with no licence or source URL, and refuses to
put a bullet collider on undergrowth.

So: keep the schema, drop "vegetation" from its name, make provenance first-class, and give it
two producers. Do NOT write a second schema.

### 4.2 Target shape

```
src/scenery/            # shared. prototype + instance records are Three-free (server cover)
  prototype.ts          # manifest record types
  instances.ts          # placed-instance records, cell keys
  InstancedCells.tsx    # (cell, prototype, primitive) buckets, LOD by geometry pointer
  ProxyQuery.ts         # WorldQuerySource over cylinder and box proxies
  alphaMips.ts          # moved from src/foliage (already Three-free and DOM-free)
```

Producers: `tools/df2-extract` (legacy `.3DI` → GLB + manifest) and `tools/vegetation`
(new GLB → normalised prototypes + manifest). Placement sources: `MissionObjects` (authored)
and `VegetationField` (grown).

`InstancedCells` is `FoliageCells` generalised one step, and `ProxyQuery` is
`VegetationWorldQuery` generalised one step. Neither is new code.

## 5. Order, and one thing deliberately late

1. **`Atmosphere.shadeLit`**, plus the GLB material pass. Written in its eventual home so it
   is not moved twice. Everything needs it; it depends on none of the rest.
2. **Foliage adopts it** — the branch's own §7.3 top item ("foliage reads darker than the
   terrain") is this defect.
3. **Retune the Lighting dials** (wire indices 29–31). They were tuned against a scene missing
   this term and both records say so.
4. **Instance the mission props.** Standalone, measured (§3), does not wait on the sweep.
5. **Run the foliage sweep** (`foliage-vegetation-design` §7.2) on real hardware.
6. **Generalise into `src/scenery/`** — AFTER 5.
7. **Real vegetation art** through the manifest.

**Why 6 is after 5 and not before.** The sweep decides cell size and the LOD distances, and
those are the two parameters most likely to move. Generalising an unsettled policy to three
consumers triples the cost of changing it, which is the opposite of what a shared library is
for.

**Explicitly NOT in this branch:** roughness and metalness from the surface-type bits
(deferred 2026-08-07). Consequence to expect rather than avoid — step 3 tunes against surfaces
that are all `roughness 1, metalness 0`, which is what makes everything read as chalk, so the
dials want a second pass when roughness lands. A known second pass, not a wasted first one.

## 5.1 MEASURED ON A GPU: the foliage layer has never rendered on WebGPU

Found the first time this branch was opened in Chrome, and it is the reason every number in
the design record is a draw-call count:

```
THREE.WebGPURenderer: Render pipeline creation failed (renderPipeline_foliage-acacia-mask_41):
  Vertex buffer count (10) exceeds the maximum number of vertex buffers (8).
```

Every foliage pipeline fails, so no plant is drawn. Ten buffers because the material declares
seven custom attributes — `sway`, `billboard`, `card`, `leaf`, `aOrigin`, `aScale`, `aSeed` —
on top of `position`, `normal` and `uv`. WebGPU's `maxVertexBuffers` floor is 8.

**Present on the branch WITHOUT any of this branch's changes** — verified by checking out the
pre-seam files and reloading, which is also how the separate `vec4()` fault below was
attributed. It went unseen because the environment the layer was built in has no GPU and falls
back to WebGL2 on SwiftShader, where the attribute limit is higher: the layer worked there and
cannot work here, and no screenshot from that environment could have shown it.

The fix is packing, and it must respect the per-vertex / per-instance split because attributes
in different groups cannot share a buffer:

- per-vertex: `card.xy` + `sway` + `billboard` → one `vec4`, with `leaf` folded in or kept
  separate (4 buffers → 2)
- per-instance: `aOrigin.xyz` + `aScale` → one `vec4`, `aSeed` separate (3 buffers → 2)

That lands at 7 and leaves headroom. **Nothing about the sweep in §5 step 5 can run until this
is done** — it is now the first task on the layer, ahead of any tuning.

## 6. Carried forward from the branch's review

Two findings worth fixing regardless of what happens to the rest:

- `VegetationWorldQuery.intersectCylinder` allocates two throwaway arrays per trunk per ray.
  One shot walks thousands of trunks.
- Two tests fire 100 m rays while asserting about a single tree, so any future change to
  `SPECIES` density or the placement hash breaks them for a reason the failure will not name.
  Bound `maxDistance` just past the target.

## 7. Open, and decided by data rather than argument

- **Authored vs grown vegetation collide.** Missions place plants as props: warfields carries
  33 `kind: "foliage"` placements (26 cypress, 7 desert bush) plus 71 tumbleweeds it classes
  as decoration; killring carries 8. Small, and the mission format already has the field to
  resolve it — authored wins where it exists, the field fills the rest, keyed on `kind` rather
  than on a name-matching heuristic.
- **Destructible props do not instance cleanly.** The intact-to-husk swap is per-instance
  visibility inside a shared bucket. No mission prop is destructible today, so this constrains
  the prototype record rather than blocking anything.
- **Whether the foliage layer earns its cost at all** is unanswered, because nothing has ever
  measured it on a GPU. Step 5 is the first honest read.
