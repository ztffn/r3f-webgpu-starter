# 03 — Terrain & Grass Rendering Design

How the render path reproduces DF2's Voxel Space 32 look — heightfield terrain plus its
signature concealing tall grass — on a modern GPU via Three.js/WebGPU/TSL.

---

## 1. Rendering strategy at a glance

The original engine was a **column raycaster**: for each screen column it marched a ray
over the heightmap front-to-back and drew vertical spans, with "stretched voxels" extruding
grass columns upward. We do **not** make that the primary renderer. Instead:

- **Primary path — polygon heightfield.** The heightmap becomes a chunked, LOD'd triangle
  mesh, textured with the colormap. This is what modern GPUs are built for and gives us
  free shadows, MSAA, depth, and post-processing.
- **Grass — hybrid.** A relief-mapped "grass slab" for the mid/far field (cheap, covers the
  concealing bulk) plus real instanced blades near the camera (tactile detail).
- **Authentic mode — optional.** A literal per-column raycaster implemented as a
  full-screen fragment shader, toggleable for nostalgia / comparison (see §7). Not on the
  critical path.

---

## 2. Terrain mesh — chunked LOD (Phase 1, scaffolded)

### 2.1 Chunking

The world is a grid of square **chunks** (default `CHUNK_COUNT × CHUNK_COUNT`, each
`CHUNK_SIZE` meters). One `THREE.Mesh` per chunk, all sharing one terrain material. Chunking
gives us:

- per-chunk frustum culling (Three.js does this automatically per mesh),
- per-chunk LOD selection,
- a bounded working set when we later stream real tiled terrain.

### 2.2 Level of detail

Each chunk can be built at one of several segment resolutions
(`LOD_SEGMENTS = [64, 32, 16, 8, 4]`, highest → lowest). Every frame, each chunk picks a LOD
from its center's distance to the camera (`Terrain.tsx`). Geometries are built lazily and
**cached per (chunk, lod)**; switching LOD just swaps `mesh.geometry` to a cached buffer —
no per-frame allocation.

### 2.3 Crack hiding — skirts

Adjacent chunks at different LODs leave T-junction cracks at their shared edge. Rather than
index-stitch (fiddly, and awkward to cache), each chunk geometry carries a **skirt**: a ring
of perimeter vertices dropped straight down by `SKIRT_DEPTH` meters. The skirt fills any gap
with vertical, correctly-colored wall, invisible in practice. This is the standard pragmatic
choice and keeps each LOD a self-contained, cacheable buffer.

### 2.4 Normals

Vertex normals are computed **analytically from the heightfield gradient** (central
differences in `Heightfield.normal()`), not from the mesh triangles. This keeps lighting
identical across LOD levels — a chunk that drops from 64 to 8 segments keeps the same
shading, so LOD transitions don't pop in luminance, only in silhouette.

---

## 3. Terrain material (TSL)

`TerrainMaterial.ts` is a `MeshStandardNodeMaterial` whose `colorNode` is a TSL graph that
blends biome albedos from **height** and **slope**:

- low + flat → sand/beach near the water line,
- mid + flat → grass (two-tone, height-varied),
- steep → rock (slope-driven, overrides the height bands),
- high → rock/snow caps.

Because it is a *Standard* node material it still responds to the scene's sun, hemisphere
fill, and fog for free. When real assets arrive, the procedural `colorNode` is replaced by a
`texture(colormap)` sample plus a detail-strip overlay — a localized change, the mesh and LOD
code are untouched.

Authoring the shader in TSL (not raw WGSL/GLSL) is what lets the same graph run on both the
WebGPU and WebGL2 backends (`05-...md` §2).

---

## 4. Grass — the concealment layer (Phase 2, not yet built)

DF2's grass is a *gameplay* feature, not just decoration: it hides a prone soldier at
range while remaining walk-through terrain. The render design must therefore produce visual
density that reads as opaque cover at distance. Two coordinated layers:

### 4.1 Mid/far field — relief-mapped "grass slab"

A second skin over the terrain (or a shader term on the terrain itself) that uses
**relief / parallax-occlusion mapping** driven by the detail-elevation strip to fake a deep
grass canopy without geometry. This is the primary concealing bulk — cheap per pixel, covers
the whole draw distance, and is where the "invisible at 800m" property visually comes from.
Height/density come from the detail map (material zone) × detail-elevation strip.

### 4.2 Near field — instanced blades (0–15 m)

Real 3D blades, GPU-instanced, populated by a **compute shader** that scatters instances on
the heightfield inside a moving ring around the camera and animates wind. This gives tactile,
parallax-correct grass you can push through. Only the near ring is ever instanced, so blade
count stays bounded regardless of world size.

### 4.3 Crossfade

Between the two layers there is a distance band where near-field blade alpha fades out as the
relief-slab density fades in, so there is no visible seam as you move.

### 4.4 Wind

A single shared wind function (time + world-position noise) drives both the blade bend and
the relief-slab UV offset so the two layers move coherently.

---

## 5. Sky, water, fog

- **Fog** is the key to selling draw distance and matching the terrain to the sky at the
  horizon (Phase 5 does the precise color-match). Scaffold uses distance fog tuned to the
  sky color.
- **Water** is a flat plane at the map's water level; the scaffold uses a simple material,
  a later pass can add reflection/refraction via node materials.
- **Sky** is a gradient/solid matched to the fog color in the scaffold; a physical sky or a
  sampled skybox from the terrain params (`02-...md` §4) comes later.

---

## 6. Performance model

- Draw calls scale with visible chunk count, not world texel count.
- Far chunks collapse to 4×4 = 32 triangles; the vertex budget is dominated by the handful
  of near chunks at full LOD.
- Grass cost is bounded by (a) the fixed near-field instance ring and (b) per-pixel relief
  marching, both independent of world size.
- Target: 60 fps at 1080p on a mid-range discrete GPU; graceful WebGL2 fallback at reduced
  draw distance.

---

## 7. "Authentic mode" raycaster (optional, documented, not built)

A faithful Voxel Space column renderer implemented as a full-screen fragment shader:

- For each screen column, march the heightfield front-to-back in world space.
- Track the running min screen-Y ("y-buffer") and paint vertical colormap spans, extruding
  grass columns by the detail-elevation strip to reproduce stretched voxels exactly.
- Rendered to an offscreen target and composited, toggled from the UI.

This is intentionally kept off the primary path: it is a comparison/nostalgia feature, and
the polygon path is what everything else (shadows, physics debug, post) builds on.
