# Converter: everything knowingly skipped, unverified, or unread

Self-audit of `tools/df2-extract` written 2026-08-07, prompted by a fair complaint: the
session's bugs were repeatedly found by the USER noticing something on screen, after which
the fix took minutes because the answer was already in NovaResearch or in the bytes. This
is the list of what is still in that state, so the next fault is found here rather than by
eye. Ordered by expected cost of leaving it.

**Standing rule this list exists to enforce:** a field the parser skips is a decision, and
an undocumented decision reads as an oversight later. Read the format page BEFORE
inferring a layout — every inference this project made was wrong at least once
(UV fixed-point twice, sub-object-local indices, the z-up reflection, the material flag
width).

## A. Fixed in the session that produced this list

- **Face flags at offset 0 were being discarded** (the C# reference calls the field
  `null0`). It is the documented face `Flags` u16, and **bit 0 = smooth-shaded**. Measured:
  set on a majority of 159,206 faces, clear on the rest. Ignoring it applied per-vertex
  normals to flat faces, rounding off edges that should be hard — most of a crate or a
  wall. Now: smooth faces use the stored normals, flat faces get one geometric normal.
  The field at offset **+2** (which this parser called `surface`) holds small sequential
  integers — an index of some kind, still unidentified, still unused.

## B. Parsed but unused — known to exist, nothing consumes them

| Item | Where | Why it matters |
|---|---|---|
| `lodDists` + LODs 1..n | `file3di` | Only LOD 0 is ever exported. Distance LODs are free performance for 365-object missions, and lower LODs may also carry coarser COLLISION. |
| Sub-object `parentBone` hierarchy | `file3di` | Ignored. Fine for static props (vertices are absolute); required the moment anything articulates — turrets, doors, animated characters. |
| Material `IndexB` / `IndexW` / `IndexA` | `file3di` | **These are CAMO VARIANTS, not render modes — see §C.6. Every vehicle currently exports in green camo regardless of map biome.** |
| Material `ANIMATED`, `SPECIAL_BLEND`, `SHADOW_PRIORITY`, `HIDDEN_AUTO` | `file3di` | Decoded into `MAT`, acted on by nothing. `ANIMATED` pairs with the texture `frames` count below. |
| Texture `frames > 1` | `file3di` | Animation frames sharing a palette; only frame 0 is exported. Fires, sirens and screens will be static. |
| Collision volume header | `file3di` | `planeCount` (offset 72) is solved and is all the grouping needs; the documented bbox and BSP child fields do NOT read correctly and are left raw. See the collision design record §5. |
| Face `surface` (offset +2) | `file3di` | Small sequential integers. Unidentified. |
| `.trn` `sun_slope`, `filter`, `gamma`, `saturation`, `horizon`, `sky_height`, `water_map` | `prepare-terrain` | Copied into `terrain.json`, applied by nothing. `sun_slope` is presumably the sun elevation the map was lit for — relevant to matching the original look. |
| `char_data` `.cal` numeric params | `prepare-terrain` | Only "non-zero = hard ground" is used. What `ct1,40` vs `ct1,10` means is unknown. |
| Mission item AI fields, `ttoolindex`, `group_id`, `map_symbol`, per-item `attrib` | `mission.mjs` | Dropped at parse. Needed for any real mission behaviour. |
| Mission `begin group` / `begin event` blocks | `mission.mjs` | Not parsed at all. Warfields declares 7 events and 8 groups; KillRing 0 events. |

## C. Known-missing behaviour that will produce WRONG output, not just less

1. **`RotateMap180` (mission attrib bit 5) is not honoured.** opennova's flag table has it;
   nothing in our importer reads the mission `attrib` at all. A map with that bit set will
   import mirrored, and it will look like an axis bug rather than an unread flag. Warfields
   and KillRing both have it clear, which is exactly why it has not bitten yet.
2. **Roll is dropped.** The BMS entity struct carries Yaw, Pitch AND Roll; the text `.mis`
   `facing` line has two angles and we map the second to pitch. If the text format encodes
   roll elsewhere, tilted wreckage is being placed with one axis missing.
3. **V7 `.3DI` models are unsupported** (`LAMP3`, `LAMPX` — 2 of 625). They fail loudly,
   which is correct, but they are simply absent from any map using them.
4. ~~Winding after the rotation fix is unverified.~~ **CLOSED** — re-measured under the
   final `(x, z, −y)` rotation with unreversed winding: CRATE1, BARREL, AMMOBOX and ADWC1
   all wind **100% outward**. (Convex models only; a concave test would need a raycast.)
5. **Only 3 of 18 retail terrains are prepared** (egypt, dmd3, dfg4). Nothing is wrong with
   the rest; they just do not exist yet.
6. **The scene's SUN is weather-independent — this is a renderer bug, not a converter one,
   and it is the visible half of the atmosphere problem.** `DF2Scene.tsx` hardcodes
   `directionalLight intensity={2.4} color="#fff4e0"` and a fixed `SUN_DIRECTION`. Only
   the hemisphere fill reads the preset, and only for its *colour*
   (`args={[weather.skyColor, "#5a5340", 0.75]}` — the 0.75 is constant too).

   So at night a lit prop gets **full warm daylight** on its sun-facing faces and near
   black on the rest, which is exactly what the night screenshots show. Terrain and grass
   escape this because they are unlit and go through `atmosphere.shade`; every lit
   surface — props, characters, imported GLBs — does not.

   Correcting an earlier claim in this document's own session: lit props are NOT
   "unlit/ignored by lighting". They are lit correctly by lights that never heard of the
   weather.

   **(a) FIXED 2026-08-07.** `weather.ts` gained `SceneLighting` + `lightingOf(preset)`:
   sun colour/intensity, hemisphere fill, ground tint and an ambient floor, derived from
   the preset's sky luminance where the preset says nothing, overridden explicitly for
   `overcast` and `night`. Contrast is modelled as the **sun-to-fill ratio** — overcast is
   a small sun (0.25) against a large fill (1.35), not a dimmer sun, because dropping only
   the key gives night-with-daylight-shadows. An `ambientLight` was added as a third light
   so a face pointing away from both sun and sky is dark rather than pure black. Three
   dials (`Sun intensity`, `Sky fill`, `Ambient floor`) appended to the shared wire table
   at indices 29-31 and rendered as a **Lighting** group on the Weather tab, keyed on the
   preset so a switch reseeds them. Verified: `?weather=night` now reads sun 0.22 /
   fill 0.35 / ambient 0.10 against the old constant 2.4.

   **(b) DELIVERED 2026-08-07** — `atmosphere.litClass(Base)` shades after lighting and
   forces the scene fog off (`docs/08` §8 invariant 7 has the mechanism and the TSL typing
   trap that cost two attempts). The water plane and the foliage layer take it. **GLB-loaded
   surfaces still do not**, because `GLTFLoader` emits plain non-node materials — so the
   night-prop case below is only half fixed, and the retune it predicts is now due. The
   original text follows.

   **Was open, and the balance will move when it lands:** (b) the post-lighting `shade`
   for fog and grade (`docs/08` §8 invariant 7). Until lit surfaces receive fog, night
   props sit in unfogged darkness and the preset values above are tuned against a scene
   that is missing a term — expect to retune once (b) exists. The night preset currently
   errs dark; the dials are the instrument for settling it against the retail game.

   **(c) There are NO real-time shadows, and nobody decided that.** Nothing in `src/df2/`,
   `src/fps/` or `src/game/` sets `castShadow`, `receiveShadow` or a `shadowMap` — the
   sun's `castShadow` is simply left at its `false` default. (Hemisphere and ambient lights
   cannot cast at all, so those two are correct by construction.) The hard black faces in
   night screenshots are unlit *facing*, not cast shadow: a building darkens its own far
   side but casts nothing onto the ground or its interior.

   Two things make this worth deciding rather than switching on: the directional light sits
   at `SUN_DIRECTION * SUN_DISTANCE`, a long way out, so its shadow camera frustum has to
   be sized to the visible world or the map resolution collapses; and **the terrain
   colormap is already pre-shaded** — it carries DF2's baked ravine shadows, which
   `TerrainMaterial`, `GrassMaterial` and `BladeMaterial` each compensate for in comments.
   Real-time shadows on top would double-darken exactly those places. Best done WITH the
   post-lighting `shade` in (b), or shadow darkness gets tuned twice.
7. **Every model exports in GREEN camo, on every map.** The four material texture indices
   the C# reference calls `IndexG/IndexB/IndexW/IndexA` are **biome skins**, and the
   reference's letters are literal: measured on `T80`, `IndexG → dt8g01` (**g**reen),
   `IndexB → dt8d01` (**d**esert), `IndexW → dt8s01` (**s**now); where a material has only
   one skin all three indices point at the same texture. This converter reads `IndexG`
   only, so a T-80 or a truck renders in jungle camo on a desert map.

   **The selector is almost certainly the mission's `terrain_color`** (in
   `general_information`, so already parsed by `mission.mjs` and currently discarded).
   The two imported maps fit: Warfields sets `terrain_color 1` on desert DMD3, KillRing
   sets `0` on green/swamp DFG4 — i.e. 0 → G, 1 → B, 2 → W. **Unverified**: confirm
   against a snow map (`DFDS1`, `DMDS2`, `DFGS1`) before trusting the mapping.

   Fix shape: `parseLod` stores all three indices per material instead of just
   `texIndex`; `toGlb` takes a `camo: "g" | "b" | "w"` option; `df2extract.mjs mission`
   defaults it from the mission's `terrain_color` and exposes `--camo` to override. Note
   the GLB is then biome-specific, so the emitted path needs the variant in it
   (`models/<name>.<camo>.glb`) or missions on different biomes will clobber each other.

## D. Formats with a NovaResearch page that nobody has read

This is the highest-value cluster, because every previous encounter with that repo
collapsed a "locked" problem into an afternoon. Pages exist for:

- **`SCR File Format`** — the container behind `.ANM`, `.DEF`, `.MNU`. The runbook has had
  this listed as workstream 7 "locked, needs Ghidra on `Cmprssh0.dll`" since it was
  written. There is a documentation page. Nobody has opened it.
- **`RTXT File Format`** — `meditems.bin`, the mission editor's string/item table.
- **`CBIN`, `BFC`, `PAK`, `AI`, `AIN`, `GSB`, `OCF`, `3DO`** — unread. `AIN` is AI
  navigation, which is what mission waypoints would need.

## E. Verification debts — believed correct, never measured

- **`HEIGHT_SCALE = 0.5`** comes from the mission-editor manual ("water level measured in
  1/2 meters") and cross-checks against plausible map relief. It has never been compared
  against the running retail game.
- **Placement convention** (`axis x,y`, `yaw = facing - 90`) is measured, but against ONE
  map — KillRing's ring and swamp. Not re-checked on Warfields, whose layout would confirm
  or break it independently.
- **Surface-type bit names** (wood/metal/glass) are inferred from two labelled bits
  matching a tree and a flag. The numeric types 12-17 have no confirmed name table. The
  419 `.wav` names in `Df2.pff` probably carry the vocabulary.
- **`?misconform`** defaults off on the strength of opennova placing entities from stored
  rotation alone. Whether DF2's runtime conformed ground vehicles is still unmeasured; the
  `axle_dist` evidence says the engine tracked ground contact for things that drive.

## F. Deliberate omissions — decided, not forgotten

- Mission atmosphere (sky, fog, water level, weather) is **not** imported. The project has
  its own measured presets and rooms own their visuals; the user asked for this explicitly.
- Retail-derived output stays under gitignored paths and is never committed.
- `Hidden` (material bit 11) is parsed and deliberately NOT acted on — honouring it removed
  a room's interior wall. See `docs/02` §4.
