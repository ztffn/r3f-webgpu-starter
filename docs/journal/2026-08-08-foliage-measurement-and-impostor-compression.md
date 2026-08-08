# Making the foliage layer measurable, then using that to pick a texture format — journal

**Feature:** foliage-measurement-and-impostor-compression
**Date:** 2026-08-08
**Status:** raw

## Goal

Two things, and the second only became possible because of the first.

The foliage layer had four sliders and no instrumentation. You could change density and
watch the frame time move, but you couldn't answer *why* — which tier cost what, which
species, whether you were triangle-bound or fill-bound. "Done" for the first half meant:
a person can look at a stand of trees and read, off the screen, which renderer drew each
plant, what LOD it's at, and how many times each pixel got shaded.

The second half was a format question that had been sitting open in the research memo
since before any of this existed: the baked impostor atlases ship as PNG and rebuild
their mip chains in the browser. Is KTX2 worth it? "Done" meant answering that with
measurements rather than the usual "compressed textures are good" hand-wave.

Also, before either: a cleanup pass over the 24 commits that built the far tier, because
reviewing your own week-old code with fresh eyes is cheaper than debugging it later.

## Problem

### The instrumentation had nowhere to live

The existing foliage controls were inside a `Foliage` section of the Scene tab, wrapped
in `{scene && BENCH.foliage && ...}`. Without `?foliage=1` in the URL the entire section
rendered nothing — no heading, no placeholder, no hint it existed. That's how the session
started: "I thought we made a debug panel for tree spawning, but I can't find it." It was
there. It was invisible. And a bare `/play` is networked by default, which silently
dropped the three rebuild dials again unless you added `?admin=1`.

Worth naming because it's a category, not a one-off: a control that renders *nothing*
when its precondition is unmet is indistinguishable from a feature that doesn't exist.

### False colour on a lit material doesn't work

The obvious way to build LOD visualisation is the way grass does it: one `uniform(0)`,
a chained `select` over an array of colour nodes, switched from a segmented button row.
`GrassMaterial.ts:1036-1057` is the reference and it's clean.

It doesn't port. Two reasons, and I hit them in the wrong order.

The near foliage tier is **lit** — `atmosphere.litClass(THREE.MeshStandardNodeMaterial)`.
Its `colorNode` is albedo only. Write a flat red there and you don't get flat red: PBR
multiplies it by the lighting term, then `setupOutput` grades and fogs it. What comes out
varies with sun angle and distance, which is precisely useless as false colour.

Worse, LOD is decided **per bucket** (`chooseLod` in `FoliageCells.tsx:429`), and one
material is shared by every bucket of a species. Uniforms live in a per-material binding
group, so there is no way to give bucket A a different value from bucket B in the same
frame. The grass pattern assumes one material, one value. Foliage needs N values from one
material, which the mechanism cannot express.

### The measurement I nearly shipped was a lie

For overdraw, the cheap approach is CPU-side: sum the projected screen area of every drawn
instance, divide by viewport area. It's ten lines. It ignores occlusion, ignores the alpha
cutout, ignores the frustum, and reads high by a factor nobody can bound.

I proposed it, flagged it as an estimate, and the response was "do it proper so it is an
actual factual tool." That was the right call and it changed the design. This project's own
design record lists "unknown rendered as a plausible number" as one of four recurring defect
categories — a `patienceScore` that confidently answered 40/100 for every player because
absent telemetry read as "never moved". A projected-area overdraw figure is the same shape.

### Assuming KTX2 is a straight win

I opened the format work believing compressed textures win on both download and VRAM. The
first measurement said otherwise, immediately and loudly.

## Solution

### Cleanup first (24 commits, ~7,350 lines)

Four review passes over the branch — reuse, simplification, efficiency, altitude. The
findings worth repeating:

**The alpha solver ran 17 full passes where 1 does.** `solveAlphaScale` bisects to find
the scale that restores a mip level's alpha coverage, calling `alphaCoverage` each step,
and each call walks every texel. Alpha is a *byte*, so coverage at any scale is fully
described by 256 suffix counts. One O(texels) pass builds the histogram; every bisection
step becomes O(256). The comparison inside is character-identical, so the answers are
exact rather than approximately the same. At an atlas mip that's one pass over a million
texels instead of seventeen — paid at page load *and* in the bake.

**The rasteriser kept two identical depth buffers.** `zbuf` and `depthBuf` were assigned
the same value in the same block, and `depthBuf`'s only read was guarded by the same
coverage flag that gated the write. A full supersampled `Float32Array`, cleared once per
view, holding a copy of a number already there. I'd restructured that function's scratch
into a struct and passed the duplicate straight through without asking whether both were
needed — a second review pass caught it.

**Prototype species allocated four identical geometry views per bucket.** Authored trees
use the same build in every LOD slot, and the bucket loop built four separate
`BufferGeometry` views over one set of attribute buffers. At the default reach that's
~2,000 redundant objects.

The technique that made all of this safe: **`npm run bake:impostors` is deterministic**, so
re-running it and checking `git status public/assets/vegetation/impostors/` proves a
refactor is byte-identical. The alpha-solver rewrite and the rasteriser restructure were
both verified that way. Cheapest correctness check in the repo.

### Two mechanisms for false colour, because the tiers genuinely differ

Near tier: **swap the material**, keyed on `(species, palette slot)`, in the same frame-loop
branch that already swaps geometry. Built lazily and cached, because each material is a
pipeline the backend compiles.

Far tier: it's unlit and already one material per species, so it switches on the shared
`debugMode` uniform with the grass-style chained `select`.

One detail I got wrong and the browser corrected: I made the debug materials **opaque**,
copying grass, which forces opacity so alpha-tested misses don't show terrain through them
and read as false values. Foliage is the opposite case. A card is *mostly hole by
construction* — the leaf texture is the plant's shape. Opaque turned every card into a
solid quad and the first screenshot was a flat green wall filling the frame. They keep the
alpha cutout now, sampling each species' own map.

Position turned out to be free: `positionLocal` arrives instance-transformed because
`NodeMaterial` applies the instance matrix *before* evaluating `positionNode`, and `fill()`
writes the full transform. The real material's `positionNode` only adds billboard and wind,
neither of which carries information a false-colour view reads. So debug materials need no
`positionNode` at all.

### Overdraw by readback

`FoliageOverdrawProbe.tsx`. Both tiers render alone into a half-float render target twice a
second and the pixels come back through `readRenderTargetPixelsAsync`.

Isolation is a **dedicated camera layer** (`FOLIAGE_LAYER = 5`). Both tiers' meshes enable
it; the probe saves `camera.layers.mask`, sets it to that layer alone, renders, restores.
The alternative — reparenting the groups into a scratch scene — fights React Three Fiber
for ownership of the graph twice a second.

Format choice was forced from both sides. Additive blending needs a **blendable** format;
`rgba32float` is not blendable in WebGPU core without an optional feature. Eight-bit unorm
*is* blendable but clamps at 1.0, which at a step of ⅛ caps the answer at exactly 8 layers
— hiding the tail the tool exists to find. `rgba16float` is the only option that both
blends and accumulates unclamped. The step is ⅛ so the on-screen ramp saturates at 8 and
stays readable; the measurement divides by the step and doesn't care what a monitor shows.

What it reports: mean layers where covered, peak, screen coverage, fraction of covered
pixels above 8. `null` means **not measured** and renders as absent, never as zero.

What it deliberately doesn't claim: it counts fragments passing the alpha test and ignores
terrain occlusion, so it's **depth complexity — the upper bound on shading work**. That's
stated in the panel, not implied.

### Isolation instead of per-pass timing

Three exposes no per-pass GPU timestamps. So attribution is removal and subtraction against
the whole-frame GPU milliseconds `PerfMonitor` already gets from timestamp queries. Per-
species and per-tier toggles remove the **draw**, not the fragments — a shader that
discards still pays for the draw, and the point of the toggle is attributing a draw.

### The format decision, measured

Toolchain was already present: `toktx` and `ktx` at `/usr/local/bin`, three's `KTX2Loader`
and the Basis transcoder WASM in `node_modules`.

First measurement, acacia albedo, 2040² (12 sprites × 170 px), 11 mip levels down to 1×1:

| | size |
|---|---|
| PNG (shipped) | 312,197 B |
| UASTC, no supercompression | 5,552,064 B |

**18× larger.** UASTC is fixed-rate 8 bpp; these atlases are mostly empty and PNG's entropy
coding crushes them. `--zcmp` is mandatory, not an optimisation. With Zstd 18: 462,483 B —
still +48% over PNG.

At that point the honest read was "download regression that buys VRAM." Then the normal
atlas:

| acacia | PNG | UASTC+Zstd |
|---|---|---|
| albedo (sparse) | 305 KB | 452 KB (+45%) |
| normal (noisy) | 2.80 MB | 1.21 MB (**−57%**) |

The normals are ~18 MB of the 24.6 MB total. Sparse content favours PNG; noisy content
favours fixed-rate. A conclusion drawn from the albedo atlas alone would have been exactly
backwards.

**Why not ETC1S**, which is smaller than both. Measured at the runtime cutoff (0.4) the far
material actually tests at:

| | coverage vs source (0.1506) | mean alpha error | pixels flipping the alpha test |
|---|---|---|---|
| UASTC+Zstd | 0.1506 (exact) | 0.22/255 | **0.000%** |
| ETC1S | 0.1497 (thinner) | 1.84/255 | **0.569%** |

ETC1S thins the silhouette. `docs/08` §8 invariant 6 says the renderer must never conceal
less than the gameplay record does — a silhouette that thins at range hands free vision to
whoever backs off, and the cheapest way to trigger it is to go prone, which is also the
strongest position. Rejected on evidence, not taste.

Mips are **supplied explicitly** (`--mipmap --levels 11`), never `--genmipmap`: the
encoder's box filter over alpha would undo the coverage solve `alphaMips.ts` exists to
perform. Albedo and normal take **different solvers** — `buildCoveragePreservingMips` and
`weightedNormalMips` respectively. I initially used the alpha solver for both, which would
have rescaled the depth channel and let the empty margin's fill normals dominate deep
levels: the documented defect that once rendered the whole ring a shade too bright.

And the audit moved onto the **shipped artefact**. `ktx2.mjs` decodes level 0 back out
(`ktx extract --transcode rgba8 --raw`) and the bake throws if coverage drops more than
0.005. A check that runs on the source cannot see what the pipeline did afterwards.

## Result

**Atlases**

| | download | VRAM |
|---|---|---|
| PNG | 24.6 MB | ~296 MB |
| KTX2 UASTC+Zstd | **13.5 MB** (−45%) | **~74 MB** (−75%) |

Shipped-coverage drift across all seven species: at most **−0.00001**. The browser's
hand-rolled PNG unfilter (one iteration per byte, ~26 MB) and the per-load coverage-
preserving mip solve are gone from the load path entirely — that was most of the post-loader
stall.

Verified in-browser: 22.6k impostors drawing, silhouettes intact under the tier view, no
console errors. Encode is ~0.5 s wall per atlas; a full seven-species bake is 2.8–4.9 s each.

**Instrumentation** — a Foliage tab with LOD / tier / species / cell-grid / overdraw views,
per-species and per-tier isolation, a LOD-distance multiplier, and live counts. Baseline
readings at density 1, 192 m reach, 768 m ring: 450 buckets, 2,025 instances, 45.5k
triangles, 1,024 cells cached, 22.6k far impostors, settled.

**Cleanup** — 40 commits on the branch, suite 395 → 404, typecheck and build clean
throughout, entry chunk unchanged at ~117 KB gzipped.

### The test that proved nothing

Worth its own section because it's the most instructive failure here.

I wrote a test asserting the KTX2 encode preserves the silhouette, with a header claiming it
would catch a swap back to ETC1S. Then I mutation-tested that claim — switched the encoder to
`etc1s`, re-ran — **and it passed**. A smooth ring fixture is easy for any encoder. Rebuilt
it as a 12×12 grid of hard-edged blobs, mutation-tested again: **passed again**.

Rather than keep guessing I corrected the header to state exactly what it did and didn't
prove, and shipped it honest. A subagent then took it further and found the actual cause,
which I would not have guessed:

The **RGB noise was the problem, and it was noise I had added myself** to work around a
`toktx` quirk. UASTC is fixed-rate and trades colour bits against alpha bits *inside a single
block*, so full-range colour noise was destroying UASTC's own alpha — 0.494% flipped versus
ETC1S's 0.562%, indistinguishable. ETC1S codes alpha in a separate slice and never paid that
cost. Replacing the noise with a smooth gradient dropped UASTC to 0.000% and left ETC1S at
0.698%. A real atlas is smooth within a leaf, so the fix is also the more faithful fixture.

Second property: the edge alpha has to be **fractional at the bake's exact supersample rate**
(2×). Binary alpha lands on the right side of the cutoff even for a coarse encoder. At 4×,
UASTC itself starts flipping 0.045%, because seventeen alpha levels stop landing on values it
represents exactly.

And the sting: **the coverage assertion alone would not have caught ETC1S.** It thins by
0.0013, comfortably inside the bound. Only the per-texel placement check separates the
formats. Someone simplifying this later would reasonably assume coverage was sufficient, so
there's now a comment saying otherwise.

### Traps worth writing down

- **`toktx` can emit a spec-violating level index.** When a flat base level supercompresses
  *smaller* than its own first mip, the index isn't sorted largest-to-smallest; libktx warns
  and `ktx extract` refuses the file outright. Real atlases carry enough variation to avoid it.
- **`ktx extract` writes indexed-palette PNGs** for sparse images, which our decoder doesn't
  read. `--transcode rgba8 --raw` sidesteps the decoder entirely. (The target is `rgba8`;
  `rgba32` is not a valid name.)
- **Passive effects can flush after a frame has run.** Moving the tier handoff band out of
  the near tier's frame loop, a `useEffect` would let a far-ring fill run first against
  placeholder defaults and build an empty ring that nothing refills until the next cell
  crossing. `useLayoutEffect` completes during commit, before any `useFrame`.
- **Visibility applied inside a budgeted job only takes effect when the job runs.** The far
  ring's species toggle did nothing until you walked into the next cell, because I'd put the
  check inside `runFill`, which only runs on a camera cell crossing.
- **Non-power-of-two block compression is fine.** 2040² with odd mips (255, 127, 63, 31, 15,
  7, 3, 1) encodes without complaint. I expected this to be a problem and it wasn't.
- **An unfocused Chrome window produces no frames**, so a frame-budgeted loader reads as a
  hang. Cost me three verification attempts before the window was brought forward.

### A misunderstanding that had been sitting in the code

`TARGET_BLOCKING = 0.55` is the **procedural generator's own calibration constant** —
`solveSizeMultiplier` scales card size until a set hits it. It is not a property of foliage
and does not apply to authored art. `foliage-geometry.test.ts` already does the right thing
for geometric LODs (a *ratio* against the asset's own LOD 0); `impostor-bake.test.ts` applies
0.55 as an absolute over a hardcoded `["acacia","bush","scrub"]`. The four authored tree
species are consequently unaudited, and would fail if reached — they measure 0.423–0.436
against a band requiring ≥0.47.

That's not a bug in the trees. It's the wrong test. Caught because someone asked "isn't that
just something the procedural generator made to calibrate itself?" — which was exactly right.

## Open

- **The tier handoff and far ring are FOV-blind.** The near tier's LOD *is* scope-aware —
  `FoliageCells` divides distance by the projection-derived zoom factor — but the handoff band
  and the ring are not. A scoped target past the 192 m spawner reach is hiding behind a baked
  impostor no matter how far you zoom. Fixing it properly means the near window has to extend
  when scoped, and buckets are preallocated for a fixed radius, so it's a design change rather
  than a tweak. This is the most gameplay-relevant item left.
- **The authored trees bypass `impostorSource.ts`**, the module whose header declares it the
  single place bake inputs are assembled. `prototypeBakeOptions` in `bake-impostors.mjs`
  assembles them inline, which is why the coverage test can't reach them. Scoped with the
  asset pipeline.
- **The near tier invalidates its whole window on every camera cell crossing.** Bucket offsets
  are relative to the camera cell, so a one-cell move re-points all ~1,183 buckets when only
  the leading edge holds new content. Roughly 92% of the repack is redundant. Needs a recycle
  keyed on absolute cell index.
- **Per-species ring buffers are each sized for the entire ring** — ~93,636 instances apiece,
  ~21 MB of `Float32Array` across seven species, when instances are *partitioned* between them
  so the sum is bounded by the same number. Six sevenths is unreachable. Fixing it needs the
  bounds check the current comment says it deliberately avoids.
- **Three copies of the glTF flattening loop** across `bake-impostors.mjs`,
  `extract-prototypes.mjs` and `prepare-vegetation.mjs`. That seam belongs to the asset
  pipeline.
- **The depth channel in the normal atlas is never sampled.** `FarFoliageMaterial` reads
  `.rgb` only. Kept deliberately — it's the alpha of a texture that must exist anyway, so it
  costs no runtime memory, and dropping it changes every committed atlas and forecloses
  parallax. Now documented so nobody re-derives it.
- **Collision view is reserved and disabled.** Trunk proxies are analytic and client-only, so
  there's nothing authoritative to draw. Listed rather than omitted, because an absent control
  claims the feature doesn't exist.
- **Nothing measured whether KTX2 helped the frame**, only download and VRAM. Plan v2 measured
  foliage at ~4% of GPU with grass at three quarters, so at current density it probably
  doesn't show. At jungle density — the actual target — the far ring's six texture fetches per
  fragment might make bandwidth matter. The overdraw tool exists now; that measurement is a
  ten-minute job nobody has done.
