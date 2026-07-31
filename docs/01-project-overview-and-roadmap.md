# Delta Force 2 Web Port — Project Overview & Roadmap

## 1. Goal

A browser-based reconstruction of Delta Force 2 (NovaLogic, 1999), targeting fidelity to
the original's two defining technical/design traits:

1. **Terrain and grass system** — NovaLogic's Voxel Space 32 engine, specifically its
   "stretched voxel" tall-grass feature, which allowed a prone player to be effectively
   invisible in grass at up to ~800m while remaining fully traversable terrain.
2. **Asset fidelity — as a means, not an end.** Where legally and technically possible, use
   real DF2-era terrain and model data (colormap/heightmap/detail-map triples, `.3DI`
   character/vehicle models) rather than recreated-from-scratch art.

   > **Decided July 2026.** Real assets are the **dial-in instrument**: they are how we tell
   > whether the terrain, scale and concealment feel right, because they are the thing
   > players actually remember. They are not the deliverable. As the project matures the
   > trajectory is **custom assets and player-created terrains**, and eventually **map +
   > terrain editor tooling** to feed the community aspect (`00` Pillar 12).
   >
   > This resolves the tension with `00`'s "Preserve Behavior, Not Assets": behaviour is the
   > goal, real assets are the fastest and most honest way to calibrate toward it. Practical
   > consequence — **a missing original asset is never a project blocker.** Where authentic
   > data is unavailable (e.g. the `dfdg1_dm` grass strip, §7), authoring a plausible
   > substitute that delivers the *behaviour* is a legitimate path, provided it is labelled
   > as such and never reported as authentic (`08-...md` §5.3).

This is a hobby/personal reconstruction project, not a commercial release.

> **Status pointer (July 2026).** For what the code actually does today — module map,
> contracts, invariants and the traps that have already cost sessions — read
> `08-implementation-spec.md`. This document is the plan; `08` is the as-built.
>
> **`00-core-design-thesis.md` is the *why*, and it sits above this document.** This one
> scopes and sequences the work; `00` states what the work is for — 12 gameplay pillars and
> the test every feature has to pass. Where a roadmap decision looks arbitrary, `00` is
> usually the reason. Note especially that `00`'s Pillar 12 names multiplayer as
> identity-critical while §2 below keeps it out of v1 — both hold, see §2.

## 2. Non-goals (for v1)

- Multiplayer / networking — **but see the note below**
- Full campaign/mission-editor parity
- Exact byte-for-byte engine emulation of Voxel Space's original raycasting rasterizer as
  the primary renderer (it is retained only as an optional "authentic mode" toggle — see
  `03-terrain-and-grass-rendering-design.md`)

> **Multiplayer is the eventual use case, and is deliberately on hold.** The intended end
> state is a multiplayer shooter, ideally 64+ players — `00` Pillar 12 names it as
> identity-critical, so this is a **scheduling** decision, not a judgement that multiplayer
> is optional. It stays out of v1 scope and **must not be designed for speculatively** —
> world rendering has to be good first, and the plan has not been laid out yet. Two
> practical consequences for anyone working now:
> **(a)** don't build networking, prediction or authority models; **(b)** don't make choices
> that foreclose it either — in particular `Heightfield.ts` and the concealment field must
> stay renderer-free so they can be sampled server-side (`08` §3).

## 3. Legal / asset-sourcing posture

- **Preferred asset source:** TXP terrain pack and TerraNova's EXP2b expansion pack for
  DF2. These are freeware, community-authored, explicitly built for redistribution —
  cleaner footing than retail assets, and by most contemporary accounts higher-quality
  terrain/grass authoring than the 1999 stock content. Post-extraction the real inventory is
  **9 EXP2b terrains and 27 from the TerrainPack** — full list in `06-...md` §3, which
  supersedes the four names originally guessed here.
- **Fallback asset source:** retail DF2 (currently ~$5 on Steam / Instant Gaming). Extracting
  assets from a purchased copy for personal, non-distributed use is reasonable; **do not**
  redistribute extracted retail assets or ship them in any public build.

> **Decided July 2026 — prepared EXP2b terrain assets are committed to this repo.**
> `public/assets/terrain/<slug>/` is in git (~2.6 MB for Green Mile). What that covers is
> exactly the *preferred* source above: 25-year-old community mod files, freeware, authored
> for redistribution, by the modding teams this project's author worked with — held in a
> **private** repo. This is the cleanest footing the project has, which is the whole reason
> EXP2b was chosen over retail data in the first place.
>
> **The raw archives are committed too** (`/assets/`, ~93 MB): `EXP2.PFF` itself, 36 `.trn`
> manifests and every extracted PCX/JPEG/TGA, across EXP2b and the community TerrainPack.
> The reason is reproducibility — with only prepared output in git, regenerating anything
> depends on a working copy sitting on one machine, and that copy is exactly what gets lost.
> Inventory, naming convention and grass-strip availability: `assets/README.md`.
>
> **Unchanged by this:**
> - **Retail-extracted data is still personal-use-only** and is not committed or shipped.
>   The community/retail distinction is the line that actually matters, not "assets" as a
>   blanket category.
> - The bullet below still applies to any **public** release: strip or replace original
>   NovaLogic assets. Note that a public deploy publishes whatever is in `public/assets/`
>   regardless of repo visibility, and that git history is permanent — both fine for
>   community mod freeware, both reasons to keep retail data out.
>
> **Practical effect:** a Git-connected Netlify build now renders the real map rather than
> falling back to synthetic fBm, so the two deploy paths converge (`08-...md` §12).
- Any future public/shared release of this project must either strip original NovaLogic
  assets or replace them with originals/licensed-alternatives.

## 4. Confirmed technical foundation

- DF2 runs NovaLogic's **Voxel Space 32** engine — a heightfield + colormap raycaster, not
  true volumetric voxels. "Stretched voxels" were a DF2-specific engine feature added
  specifically to simulate tall grass capable of concealing a character at any distance.
- Terrain data per map is a small set of flat 2D image files packed into `.pff` archives,
  indexed by a plaintext `.trn` manifest: colormap (JPEG 1024²), heightmap (PCX 1024²
  8-bit greyscale), detail map (PCX 1024² palettized, grass/sand/rock zoning), a detail
  color strip and a detail elevation strip (each 64×16384 = 256 tiles of 64×64), plus
  ancillary sky/water/lighting scalars. **All of this is now confirmed against real
  extracted data** — see `06-asset-extraction-findings.md`; byte-level spec in
  `02-asset-format-specification.md`.
- Character/vehicle geometry is stored in NovaLogic's proprietary `.3DI` format (version
  V8 confirmed), fully reverse-engineered structurally (see spec doc) via the open-source
  `Acruid/NovalogicTools` repository (MIT-adjacent, GitHub).
- Archive container is `PFF3`/`PFF2`, fully understood (20-byte header, 32-byte file
  records).

## 5. Chosen tech stack (summary — full detail in `05-engine-architecture-tech-stack.md`)

- **Three.js**, using `WebGPURenderer` (production-ready since r171) as primary backend,
  with Three.js's automatic silent fallback to WebGL2 for the ~5% of browsers without
  WebGPU support.
- **TSL (Three Shading Language)** for all custom shaders — single JS-authored shader
  graph compiles to both WGSL (WebGPU) and GLSL (WebGL2), avoiding a dual codebase.
- Node.js/TypeScript asset extraction pipeline (PFF3 unpack → TGA/PCX → PNG, `.3DI` →
  glTF/OBJ), built independent of the game engine, run offline as a build step.

## 6. Phased roadmap

> **Roadmap rewritten July 2026** after real terrain data was successfully extracted from
> two community modding installers (`06-asset-extraction-findings.md`). This removed the
> Phase 0 blocker and reordered priorities: **getting a real, recognizable DF-era map
> running in the browser is now the immediate milestone**, because visual/spatial "feel"
> against a map we actually played is the fastest way to validate the whole approach.

### Phase 0 — Asset pipeline (✅ core done)
- ✅ `.pff` (PFF3/PFF2) unpack + `.trn` manifest parse — implemented and validated in
  `tools/df2-extract`.
- ✅ Terrain naming/format convention confirmed empirically (`02-...md` §5).
- ✅ PCX (8-bit RLE) decoder + JPEG passthrough → PNG (`imageio.mjs`).
- ✅ Bake `grassHeightField` = `detail_map` index → `detail_elev` tile height
  (`prepare-terrain.mjs`) — the shared field for grass rendering *and* concealment.
- ⬜ Later: `.3DI` → glTF for a first character/vehicle model (not on the terrain path).

### Phase 1 — Terrain renderer (✅ done)
- ✅ Chunked/LOD heightmap mesh, skirts, analytic normals, TSL biome material.
- ✅ **Infinite tiling** — a camera-centred chunk window with geometry cached by *wrapped*
  chunk index. Not in the original plan; added once we confirmed DF2 terrain has no edges
  (`06-...md` §10). See `08-...md` §6.2.
- ⬜ Optional literal Voxel Space raycast "authentic mode" as a fragment-shader toggle.

### Phase 1.5 — Real-map demo (✅ done, except calibration)
Swap synthetic fBm for a real extracted terrain end-to-end. Deliberately pulled *ahead* of
grass, because it is cheap (the renderer already exists), needs no missing base-game assets,
and immediately answers "does this feel like DF2?".
- ✅ Decode one terrain's `_d.pcx` heightmap → height source for the existing chunked mesh.
- ✅ Drape its `_c.jpg` colormap as the surface texture (replacing the procedural biome blend).
- ▶ **STILL OPEN — and now the top of the roadmap.** Calibrate the two unknown scales,
  `HEIGHT_SCALE` (greyscale→meters) and `METERS_PER_TEXEL` (1024² grid→world size). They are
  still the placeholder values in `config.ts`, so **the milestone's own question — "does this
  feel like DF2?" — is not actually answered yet.** Do this before more grass work.
- ✅ Apply the `.trn` environment scalars: `water_height`, `filter` RGB tint. (`sky_height`,
  `horizon`, `sun_slope` are parsed but not yet used.)
- ✅ **Shipped map:** EXP2-Green Mile (`TERRAIN_SLUG = "gmile"`). Others still available:
  Balnakiel / 1stLook / River, or any of the 27 TerrainPack maps.

### ▶ Phase 1.6 — Multi-map loader (**next after the first map is human-tested**)
> **Sequenced deliberately.** Green Mile gets flown, judged and dialled in by a human first —
> a second map before the first one feels right just doubles the unknowns. Once it does:

- ⬜ Replace the hardcoded `TERRAIN_SLUG` with runtime map selection (the loader already takes
  a slug; the constant is the only thing pinning it — `08-...md` §6).
- ⬜ Prepare several more real DF-era maps and switch between them **to further validate
  look/feel** — the point is cross-checking that the renderer is right in general, not just
  tuned to one heightmap. 9 EXP2b + 27 TerrainPack terrains are already extracted (`06` §3).
- ⬜ **Prepare one of the self-contained grass maps — this is the sleeper item.** egypt
  (`ct1_dm`) and R66 / blizzard / vul001 (`ct2_dm`) ship their own `detail_elev` strips, so
  they load as `grassSource: "real"` and exercise the authentic `detail_map` → strip →
  stretch-height path end to end. **Green Mile structurally cannot do this**, so today the
  real grass data path has never actually been run. It also closes acceptance criterion 3 in
  `07` §3, which is untestable on a stand-in canopy by construction.
- ⬜ Per-map environment scalars already parse; verify they actually differ map to map.
- This is also the first step toward `00` Pillar 12: the same runtime path that loads a
  second official map is the one that later loads a player-made one.

### Phase 2 — Grass renderer
> **The built approach diverges from the plan below.** What shipped is a *columnar
> per-fragment march* — closer to what the original actually did — not the relief-mapped
> "grass slab" described here and in `03`. See the AS BUILT note in `03-...md` §4.1, the
> evidence in `07-...md` §6, and the contract in `08-...md` §6.4. The near-field compute
> blade layer has not been started and the plan for it still stands.

- ✅ Columnar mid/far-field grass driven by the baked canopy field, writing its own depth.
- ✅ **Performance target met** (July 2026). 8.3 ms standing *and* prone at Green Mile,
  dpr 1 — the 120 Hz vsync cap, so true cost is lower and unknown. Was 72.10 ms. The
  largest single win was a stale constant running the march at 8x its designed sample
  count, not an algorithm change (`09-...md` §3.1.0). Horizon culling was never needed
  and stays in reserve for the scoped case, which is still unmeasured.
- ⚠️ **Open: horizontal layering.** Grass reads as stacked slabs rather than stretched
  columns, worst approaching a crest. Cause understood — coarse stepping lands the hit on a
  column's horizontal TOP face instead of its vertical near face. **Next structural work is
  DDA cell traversal bounded by an analytic exit** (`09-...md` §3.1, `08-...md` §9), which
  cannot step over a column and is how Voxel Space did it.
- ⬜ Compute-shader near-field 3D blade instancing (~0–15m) for tactile/interactive detail.
  Now also the agreed answer to **crouch/prone quality**, which is the raymarch's
  structurally weakest case. Visual only — the march stays authoritative for concealment so
  the gameplay field does not fork. Separate PR.
- ⬜ Distance crossfade between the two.
- ⚠️ **Data note — corrected.** An earlier version of this doc said to substitute the bundled
  `ct1_dm`/`ct2_dm` strips for the missing `dfdg1_dm`. **Do not.** Strip tile *indices* are
  per-grass-set, so another set's strip puts grass at arbitrary heights — plausible-looking
  and wrong. `loadTerrain.ts` refuses a substituted bake and falls back to a labelled
  colormap-derived stand-in instead (`08-...md` §5.3). Validating the *renderer* on that
  stand-in is fine; validating grass *placement* is not.
- Full design rationale in `03-terrain-and-grass-rendering-design.md`.

### Phase 3 — Concealment system (⬜ demonstrated, not built)
- ⬜ Decoupled gameplay heightfield sampled independently of the render path, for
  line-of-sight / prone-concealment logic at any range. Reads the *same*
  `grassHeightField` as Phase 2. Full design in `04-concealment-system-design.md`.
- **Demonstrated, not yet built.** The mechanic is verified end-to-end in the test rig
  (`07-...md` §8): prone reads 0 px of visible target even scoped at 50 m and 300 m, while
  standing reads 525 px. That is a rendered-pixel measurement, not the analytic query this
  phase specifies — the query API itself does not exist yet.

### Phase 4 — Integration (⬜ not started)
- ⬜ First-person controller, physics (rapier or cannon-es), basic AI/objectives.
  *(What exists today is a camera rig only — `FlyControls.tsx` clamps to the surface at a
  stance eye height. No physics, no collision.)*
- ⬜ ECS (bitECS) as entity count grows (`05-...md` §3).

### Phase 5 — Polish (⬜ not started)
- ⬜ Wind animation tuning, LOD blend tuning, color-matching at draw distance, audio.

### Phase 6 — Authoring & community (⬜ not started, but it is the direction)
`00` Pillar 12 makes this identity-critical rather than a nice-to-have: longevity comes from
player-created content. The sequencing is deliberate — tools come *after* the look/feel is
dialled in, because an editor that authors the wrong feel is worse than no editor.
- ⬜ Custom (non-extracted) terrain and grass assets, so a build can ship with nothing
  NovaLogic-authored in it. This is also the cleanest answer to the legal posture in §3.
- ⬜ Map + terrain editor tooling — heightfield paint, detail/canopy zoning, `.trn`-equivalent
  environment scalars.
- ⬜ A distribution story for community maps. The constraint it must respect (§3): a public
  sharing mechanism carries *player-authored* data, not repackaged **retail** game data.
  Community freeware terrain is a different case — that is what this repo already carries.

### Not a numbered phase, but shipped
- ✅ **Test build** — free-fly / on-foot camera with stances, instrument HUD showing position,
  AGL, frame time and active backend, plus `netlify.toml`. Deploy notes in the README; the
  CLI path carries prepared assets, a Git-connected build falls back to synthetic fBm.
- ✅ **`tools/grass-rig`** — headless measurement harness. Exists because eyeballing repeatedly
  passed builds that were measurably wrong (`07-...md` §5, `08-...md` §10).

## 7. Open questions — status

**Resolved** by the July 2026 extraction (`06-asset-extraction-findings.md`):

- ~~Exact resolution of heightmaps/colormaps~~ → **1024×1024** for both (colormap JPEG RGB,
  heightmap PCX 8-bit greyscale). Not tiled.
- ~~Fixed vs. per-terrain detail-map palette~~ → **authored per-terrain**; the palette
  *index* is the key into the 256-tile detail strips (Green Mile uses 62 distinct indices).
- ~~Relationship between the detail elevation strip and per-texel grass height~~ → the strip
  is **256 stacked 64×64 greyscale tiles**; `detail_map[x,z]` selects tile _i_, whose
  greyscale is that texel's grass **stretch height**. A per-index lookup, not a linear scale.

**Still open:**

- **Vertical/horizontal world scale.** Greyscale→meters for the heightmap (`HEIGHT_SCALE`)
  and the 1024² grid's real-world extent (`METERS_PER_TEXEL`). Calibrate visually during
  Phase 1.5; the ~800m concealment range is a useful sanity anchor.
- **Stretch-height→world-units scale** for `detail_elev` (same calibration exercise).
- **The classic grass set `dfdg1_dm`/`dfdg1_cm`**, referenced by Balnakiel/Green
  Mile/1stLook/River but only present in a base-game `.pff`. **Do not substitute another
  set's strip** — see the corrected data note in Phase 2 above and `08-...md` §5.3. Until a
  base DF2 install turns up, those maps render a labelled colormap-derived stand-in canopy,
  and any grass result measured against it must say so.
- Whether `char_data` (always the `_cm` strip in observed data) carries anything beyond the
  detail-color strip.
