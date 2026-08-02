# Near-field instanced grass blade layer

## Objective

Add a near-field layer of instanced grass blades that overlays — never replaces — the existing
relief march, so that the near field stops reading as flat blocks while the canopy field remains
the single source of truth for where grass is, how tall it stands, and what colour it is.

The layer must satisfy four properties:

1. **Small.** Order a few thousand blades, live on a slider. The march still draws the dense
   canopy underneath, so blades supply silhouette, not coverage.
2. **Canopy-driven.** Height, density and colour all derive from the same textures the march
   reads (`src/df2/GrassMaterial.ts:476` `canopyBase`, `:457` `groundAt`, and the colormap), so
   the two layers agree by construction rather than by a copy that can drift.
3. **Thinning with distance**, stochastically rather than by a fade.
4. **Wind-bearing.** Blades bend to `BallisticEnvironment.windVelocity`
   (`src/fps/combat/BallisticEnvironment.ts:13`), which already drifts bullets, turning grass
   into the instrument a shooter reads to judge windage.

A second phase adds player-crushed trails, which convert prone concealment from a free advantage
into one that leaves evidence.

The design brief this executes is `docs/03-terrain-and-grass-rendering-design.md` §4.4, which
carries the recovered reference parameters, the shading model to reject, and the open decisions.

## Assumptions

- **Overlay, not replacement.** The march keeps running everywhere it runs today. Blades are
  visual only; concealment stays authoritative on the march and the CPU heightfield
  (`docs/04-concealment-system-design.md` §2). This resolves the open question in §4.4 item 3
  toward the safe answer, because replacement risks invariant 6.
- **Blades never feed gameplay queries.** No blade geometry is registered with `CompositeWorldQuery`
  (`src/df2/DF2Scene.tsx:291`) and none of it is raycastable.
- **V2's stated purpose is forward-looking.** There is no remote-player or other-actor concept in
  the codebase today; `PlayerMotorSnapshot` (`src/fps/core/PlayerMotor.ts:9`) describes the local
  player only. Trails therefore deliver a self-visible tell and an AI-tracking affordance now, and
  become a player-tracking mechanic when networked actors exist. The plan does not pretend
  otherwise.
- Work continues on branch `feat/grass-blade-layer`, which is based on current `main` and already
  carries the two brief-revision commits.

## Implementation Plan

- [ ] 1. **Add the toggle and the tuning constants before any rendering code.** Extend
  `src/df2/bench.ts` with a blade switch following the exact shape of `grassCap`
  (`src/df2/bench.ts:37` for the field, `:108` for the parse), so the layer can be measured
  against its own absence at an identical camera pose. Add blade constants to `src/df2/config.ts`
  alongside the existing grass block (`GRASS_CELL` at `:148`, `GRASS_FADE_START/END` at `:243`):
  instance count, field radius, thinning start and end radii, minimum keep probability, blade
  width and height scale. Each constant carries its rationale inline, matching the commenting
  convention already used throughout that file. Doing this first is not bookkeeping — the brief
  records that the camera cap's real cost stayed invisible for an entire session because no such
  toggle existed, and the same trap is waiting here.

- [ ] 2. **Build the blade geometry factory as a standalone, testable module.** A new file under
  `src/df2/` producing a single tapered blade: three vertices per ring across a small number of
  rings, width narrowing toward the tip, and the centre vertex displaced along its local depth
  axis so the cross-section reads as a shallow V rather than a flat ribbon. Supply a UV whose
  vertical component runs zero at the root to one at the tip, because every later stage — wind
  anchoring, colour ramp, trail masking — keys off that value. The file needs the five-line
  purpose header the project requires. Keep the ring count a parameter so the look decision in
  §4.4 item 1 can be swept rather than argued.

- [ ] 3. **Generate the instance field on a camera-following wrapped grid.** Instances hold a
  fixed local offset within a disc, plus a stable per-instance random payload carrying bend, height
  scale and a signed variation seed. The whole field translates to the camera's position snapped to
  a grid cell, so blades wrap as the player moves instead of being rebuilt. Distribute the radial
  offsets so density is higher near the eye rather than uniform over the disc, since uniform disc
  sampling puts most instances at the rim where they are least useful. The per-instance random must
  be stable under wrap — a blade must not change identity when the field shifts — which means
  deriving it from the wrapped world cell, not from the instance index.

- [ ] 4. **Write the blade material in TSL, performing placement in the vertex stage.** This is the
  central task and the one that discharges the third-representation risk structurally. Each
  instance samples the canopy, jitter and height textures itself and computes: its ground height,
  its full height, whether it exists at all, and its colour. Because it reads the same textures the
  march reads, agreement is automatic. Rejected blades collapse to a degenerate triangle rather
  than being discarded in the fragment stage, so they cost no fragments. Mirror the march's own
  height formula exactly — the smooth canopy envelope times the jittered strand multiplier, as
  assembled at `src/df2/GrassMaterial.ts:811` and the lines following — so a blade stands exactly
  as tall as the columns it sits among. Author in TSL, never raw GLSL or WGSL, since one graph
  serves both backends; the reference material in §4.4 is GLSL and must be ported, not pasted.

- [ ] 5. **Sample ground height through the mesh's own LOD surface, with the half-texel
  correction.** Blade bases must read the decimated mip chain built by
  `src/df2/heightTexture.ts:42` and apply the half-texel offset that scales with the mip level,
  exactly as `groundAt` does at `src/df2/GrassMaterial.ts:457`. This is called out separately
  from task 4 because `docs/08-implementation-spec.md` §11 records it as having cost a full
  session once already, and states explicitly that every new consumer of the height map needs the
  same correction. Skipping it produces blades that float or sink on slopes and that shift as the
  camera turns.

- [ ] 6. **Drive existence from canopy density and distance through a single test.** Combine the
  distance-thinning probability and the local canopy density into one comparison against the
  per-instance random. This gives both required behaviours from one branch: terrain with no canopy
  grows nothing, short canopy grows sparse, and blades thin toward the field edge. Stochastic
  thinning is not a preference here but a constraint — opacity feeds an alpha test, and the
  codebase already recorded that a crossfade through a binary test collapses into a hard ring
  (see the fade note in `src/df2/GrassMaterial.ts`).

- [ ] 7. **Take colour from the colormap, not from a palette.** Sample the colormap at the blade's
  own base position, apply the same per-column tone hash the march uses, and apply the same
  base-to-tip brightness ramp anchored on `GRASS_SHADE_BASE` (`src/df2/config.ts:212`). Keep the
  material unlit, following the existing grass and terrain materials, because the colormap is
  already pre-shaded. Explicitly do not port the reference's lighting model or its random
  green-to-brown palette; §4.4 records why both would break the look.

- [ ] 8. **Bend blades to the authoritative wind vector.** Displace along the horizontal direction
  of `windVelocity` rather than a fixed axis, weighting the displacement by the UV's vertical
  component raised to a power so the root stays planted, and subtracting a height-proportional lag
  from the noise time so a gust travels up the blade instead of the whole blade wobbling in
  unison. Shorten the blade vertically in proportion to how far it bends, or bending will visibly
  stretch it. Vary phase and speed per instance so the field does not pulse. The wind vector must
  come from the same source the ballistics reads
  (`src/fps/combat/BallisticEnvironment.ts:26`), or the indicator lies to the player.

- [ ] 9. **Wire the layer into the scene beside the existing grass.** Construct it in the grass
  memo in `src/df2/DF2Scene.tsx:204` where the material, jitter bake and height texture are already
  assembled, dispose it in the cleanup effect at `:259`, and add it to the terrain group. Follow
  the camera-following placement pattern already proven for the cap in `src/df2/Terrain.tsx:278`,
  including its two hard-won details: the object lives in the terrain group and is moved onto the
  camera each frame rather than parented to it, because the R3F camera is not in the scene graph;
  and it is excluded from raycasts, because the raycaster ignores visibility and would otherwise
  report hits to the rangefinder.

- [ ] 10. **Measure with the vsync cap escaped, and record the numbers.** Compare the layer against
  its own absence at an identical pose using the task 1 toggle, prone as the primary case, with the
  canopy forced on. Push resolution and march steps until both sides read clear of 8.3 milliseconds
  before drawing any conclusion — everything on the reference machine sits at that cap, and it hid
  a 9.7 millisecond cost until deliberately unmasked (`docs/09-performance-plan.md` §0.1). Record
  the result in `docs/09-performance-plan.md` whether it is good or bad.

- [ ] 11. **Settle the primitive by looking, then tune density and radius.** Sweep ring count,
  blade width, field radius and instance count. Judge against the recognisability test in
  `docs/00-core-design-thesis.md` rather than against the reference demos, whose stylised blades
  would fail it. Check several positions and several headings, since the project has already been
  burned by declaring a fix good from a single vantage.

- [ ] 12. **Verify the fairness direction explicitly.** Confirm that blades do not occlude more
  than the canopy field implies. The renderer must never conceal less than the field says
  (`docs/08-implementation-spec.md` §8 invariant 6), and the mirror failure matters too: blades
  dense enough to blind the player where the field counts a target visible would break the
  symmetry that concealment depends on. Inspect with the hit-distance and hit-mask debug views
  prone as well as standing.

- [ ] 13. **Record the as-built contract.** Update `docs/08-implementation-spec.md` with the new
  module in the map at §3, the new constants in the table at §7, and any trap discovered along the
  way in §11. Update the §4.4 open decisions in
  `docs/03-terrain-and-grass-rendering-design.md` to record which way each was settled and why.
  The project treats these documents as the spec rather than as commentary, so this is part of the
  work, not paperwork after it.

- [ ] 14. **V2 — stamp a displacement field from player movement.** Add a small render target
  holding displacement magnitude and bend direction, sized in world metres around the player and
  fixed in resolution regardless of display size. Stamp into it from the local player's position
  and stance via `PlayerMotorSnapshot` (`src/fps/core/PlayerMotor.ts:9`), with prone stamping a
  wider and deeper mark than walking, since crawling is the movement this mechanic is about.
  Decay the field over time so trails fade rather than accumulating forever. Prefer a rise-fast,
  fall-slow response so grass springs back gradually.

- [ ] 15. **V2 — displace blades from the field, and tune persistence as a game balance dial.**
  Blades sample the target by world position, push along the stored bend direction masked to spare
  the root, and drop slightly in height. Rotate the bend direction per instance so blades do not
  all lean identically. The decay rate is the balance knob that decides how long a crawl remains
  trackable; treat it as a gameplay decision to be settled against the pillars in
  `docs/00-core-design-thesis.md`, not as a visual constant. Document explicitly that this becomes
  a player-tracking mechanic only once networked actors exist, and that until then it is a
  self-visible tell and an affordance for AI.

## Verification Criteria

- With the layer disabled by its URL toggle, rendering is byte-for-byte the behaviour that ships
  today, and the frame time returns to its current value at the same pose.
- Over terrain where the canopy field is zero — roughly 11% of Green Mile per
  `docs/06-asset-extraction-findings.md` §7.1 — no blades appear at all, confirmed with the map's
  real canopy rather than the forced-full-canopy bench default.
- Blade height tracks canopy height: forcing the canopy to full raises blades to the same height as
  the surrounding relief columns, and the two layers show no visible height seam.
- Blades sit on the terrain surface with no floating or sinking, verified specifically while
  crossing a chunk LOD boundary on a slope and while rotating the camera in place, which is the
  signature of a missing half-texel correction.
- Blade density falls off with distance and no hard ring is visible at the field edge.
- Blade colour matches the colormap under them; a blade over a dark patch is dark and a blade over
  a light patch is light, with no independent palette showing through.
- Wind direction on screen matches the vector supplied through the wind URL parameters, and
  reversing the parameter reverses the visible lean.
- The measured frame cost of the layer is recorded as a number obtained clear of the 8.3
  millisecond vsync cap, with the pose, resolution, step count and canopy mode all stated.
- TypeScript passes, the production build passes, and the existing 43 tests still pass.
- The WebGL2 path either renders the layer correctly or disables it cleanly with no error.
- For V2: a crawl leaves a visible trail that decays over a stated time, and the trail is absent
  when the player stands still.

## Potential Risks and Mitigations

1. **The blade layer becomes a third representation of the canopy that disagrees with the other
   two.** This is the failure the brief names as its one hard constraint, and the project has
   already lost a session to two representations disagreeing by half a texel.
   Mitigation: derive every blade property in the vertex stage from the same textures the march
   samples, never from a CPU copy or a fresh noise function, and reuse the march's own height
   formula rather than reimplementing it. Task 4 exists specifically to make agreement structural
   rather than maintained.

2. **Overdraw when prone, where blades fill the frame.** Both reference implementations identify
   overdraw rather than triangle count as the bottleneck, and prone is exactly the case where thin
   overlapping geometry stacks up.
   Mitigation: measure prone first and with the vsync cap escaped; keep blades single-sided; reject
   instances by collapsing them to degenerate triangles rather than discarding fragments; treat
   instance count and radius as the first dials to turn if the cost is unacceptable.

3. **The cost hides under the 120 Hz vsync cap and the layer ships looking free.** This has already
   happened once in this subsystem, to a 9.7 millisecond cost.
   Mitigation: task 1 puts the toggle in before the feature exists, and task 10 requires both sides
   of the comparison to read clear of the cap before any conclusion is recorded.

4. **Blades conceal more than the canopy field implies, inverting the fairness guarantee.** Dense
   near blades could blind the player where the analytic field counts a target as visible, breaking
   the symmetry that makes concealment fair in both directions.
   Mitigation: task 12 verifies the direction explicitly with the debug views; density remains
   bounded by the canopy value rather than being a free parameter.

5. **The look fails the recognisability test.** The reference blades are stylised and modern, and
   DF2's grass had no blade silhouettes at all, so this layer is a departure by construction.
   Mitigation: keep the primitive a parameter, sweep it in the rig, and judge against the pillars
   rather than against the demos. The brief already proposes a tapered, near-flat, world-anchored
   blade as the first candidate precisely because it preserves the columnar identity.

6. **Scope creep from V2 into V1.** The trail system is the most interesting part and the most
   tempting to start early, but it depends on the blade layer being performant enough to keep.
   Mitigation: V2 tasks are gated behind the task 10 measurement. If the layer does not earn its
   frame time, the trail work is moot.

7. **V2 is planned against actors that do not exist.** Player tracking presumes other players.
   Mitigation: the assumption is stated up front; V2 is scoped to deliver a self-visible tell and
   an AI affordance, with the multiplayer framing recorded as future value rather than as a
   deliverable.

## Alternative Approaches

1. **Camera-facing sprites instead of real geometry.** Cheaper per blade and the approach one
   reference argues for explicitly, since single-faced sprites halve fragment work. Rejected as the
   default because billboards rotate with the camera and would swim against DF2's world-anchored
   vertical columns, and because at a few thousand instances real geometry is affordable. Worth
   revisiting if task 10 shows the fragment cost is prohibitive.

2. **CPU-side placement, uploading instance matrices per frame.** Simpler to reason about and
   debuggable with ordinary tooling. Rejected because it duplicates the canopy field on the CPU and
   reintroduces exactly the drift risk that task 4 is designed to eliminate. It would also need a
   CPU-readable copy of the canopy texture that nothing else requires.

3. **A compute shader for placement and culling, as one reference uses.** The most scalable option
   and the right answer at a million blades. Rejected at this scale because it would fork the
   WebGPU and WebGL2 paths for a few thousand instances, against the project's rule that one shader
   graph serves both backends.

4. **Let blades replace the march within their radius.** Cheaper, since it avoids shading the same
   pixel twice. Rejected because the march is what guarantees coverage, and any gap in blade
   coverage would show as bare ground where the field counts a target concealed. Overlay is the
   conservative direction with respect to invariant 6.

5. **Do nothing, and instead make the relief cell size track the pixel footprint.** The near-field
   blockiness is caused by a world-fixed cell size, so quantising the cell to the pixel footprint
   addresses the root cause without a second layer at all. Recorded in
   `docs/08-implementation-spec.md` §9 as a candidate. Rejected as the primary path because it
   cannot deliver blade silhouettes or wind response, which are the two things this layer is for,
   but it remains the cheaper fallback if the blade layer fails its measurement.
