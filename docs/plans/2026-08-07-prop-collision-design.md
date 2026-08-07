# Prop collision: converting DF2's volumes into our world

Design record for turning the collision data embedded in `.3DI` models into something the
Rapier motor and the shooting path can use. Scope: what the source data is, what we emit,
how the client and the authoritative server both consume it, and what is still unsolved.
Written before implementation so the FORMAT is agreed first — everything downstream is
cheap to change, the on-disk contract is not.

Prerequisite reading: `docs/02` §4.5 (collision records, material flag table),
`docs/12` (motor/server split), `docs/plans/2026-08-06-retail-df2-reverse-engineering-runbook.md`.

## 1. What DF2 actually stores

Per LOD, embedded in every `.3DI`:

- **`ColPlanes`** — 8 bytes each: normal in 1.14 fixed point (÷16384) then a distance,
  in model units (1/256 m). **Parsed and verified**: all 23,461 planes in the retail
  corpus have unit-length normals, and a crate's six planes sit exactly at its mesh
  extent.
- **`ColVolumes`** — 80 bytes each. Convex regions bounded by those planes, with BSP
  child indices. **Layout unsolved** (§5).

388 of 623 models carry collision: 23,461 planes over 3,083 volumes. It is a **separate,
much coarser representation than the render mesh** — a 475-face adobe building is 18
volumes over 146 planes; a crate or a stone column is 6 planes, i.e. a box.

Surface identity is NOT here. It lives on the **material** (flag bits 16-19, 26-29), so
the engine resolved "what did I hit" from the material of the face struck, not from the
volume. That split is the single most important thing to carry across, and §4 says how.

## 2. Why not just use the render mesh

Tempting — we already parse triangles, and a BVH over them is a solved problem. Rejected:

- **It is not what the game did**, and prop collision is gameplay. A crate whose corners
  are round in the mesh but square in collision behaves the way players remember.
- **Cost**: 365 props on Warfields at hundreds of triangles each is ~100k triangles of
  static collision. Convex hulls are ~3k primitives for the same map.
- **The authoritative server pays it too** (§4), and it is the machine we care about.
- Convex hulls give Rapier its fast path; trimesh colliders are the slow one and cannot
  be used for dynamic bodies at all if props ever become destructible.

Keep the render mesh available as a *fallback* for models with no collision data
(235 of 623 have none) — for those, a bounding box from the mesh is the honest stand-in,
and it must be recorded as such so nobody mistakes it for authored data.

## 3. What we emit

**Collision travels WITH THE ASSET, inside the GLB's `extras`. One file per model.**

An earlier draft of this document put collision in a per-mission `collision.json`, on the
argument that reading it out of a GLB would force a glTF parser into the Node server. That
argument is **wrong**, and three things kill it:

1. **A GLB needs no glTF library to read `extras`.** The container is a 12-byte header, a
   JSON chunk and a BIN chunk. Pulling a custom `extras` block out is ~20 lines of
   `readUInt32LE` and `JSON.parse` — no Three.js, no mesh decoding, no dependency. This
   repo's own verification scripts already do exactly that. The rule the server actually
   has to honour is *no Three.js at runtime* (`docs/12` §3), and this honours it.
2. **Moving objects break mission-scoped collision.** A vehicle's hulls are in its local
   frame and must move with the body every tick. Binding them to a mission file rather
   than to the vehicle asset is the wrong ownership: the same T-80 appears in many
   missions and carries the same collision in all of them.
3. **User-supplied assets have no mission file.** Once the editor lets people upload their
   own GLBs, a per-mission sidecar only ever describes OUR converted props. Collision has
   to be a property of the asset, or user content is second-class by construction.

So: `models/<name>.glb`, with hulls under the mesh's `extras`, and nothing else to keep in
sync. A mission file references models by name and never carries geometry.

Shape of the `extras` block:

```jsonc
// gltf.meshes[0].extras
{
  "df2Collision": {
    "units": "meters",
    "source": "authored",              // or "convex-decomposition" / "mesh-aabb"
    "hulls": [
      {
        "surface": 17,                 // bullet-impact surface type, or null
        "planes": [ { "n": [1,0,0], "d": 1.41 }, ... ],
        "vertices": [ [x,y,z], ... ]   // derived, see below
      }
    ]
  }
}
```

`extras` is standard glTF and every loader preserves it, so the asset stays a plain GLB
that opens in any viewer — it does not become a private format.

Emit **both** the planes and the derived vertices:

- **Planes** are the source of truth and survive a future fix to the volume layout.
- **Vertices** are what Rapier's convex-hull collider actually wants, and deriving them
  (intersect every plane triple, keep points inside all half-spaces) is fiddly enough
  that doing it once offline beats doing it in every client at load.

Both in **metres**, and under the **same −90° rotation about X** the mesh export uses
(`(x, y, z) → (x, z, −y)`, `docs/02` §4). A collision hull in a different frame from its
mesh is the exact class of bug that cost this project a day; the converter must apply one
shared transform to both.

## 4. Runtime

**Client and server build the same colliders from the same asset.** The server reads each
GLB's JSON chunk for the `extras` block — no Three.js, no glTF library (§3) — and never
touches the BIN chunk, so it pays nothing for geometry it does not render. Static props
become
fixed Rapier bodies with a compound collider of convex hulls, inserted once at map load.
~3k hulls for a full mission is unremarkable for Rapier's broadphase; nothing is per-frame.

**Shooting.** One Rapier raycast against the same colliders returns the hull that was hit,
and the hull carries its `surface` — so impact effect, sound and any penetration model key
off it directly, with no second query and no mesh BVH. This is the whole reason surface
type is baked per hull at conversion time rather than resolved at runtime.

Which means the converter has to answer a question the source data does not: **volumes have
no material, materials have the surface bits.** Bake it by proximity — for each hull, find
the render faces whose centroids lie closest to that hull's planes, and take the most
common surface type among them. Where a hull's faces disagree (a window in a wall),
record the dominant one and note the ambiguity; a per-hull answer is what a raycast can
use, and DF2's own answer was per-face, so a small loss is expected here.

**Player collision** reuses the identical bodies. Today the motor collides only with the
terrain heightfield; props are not in the world at all, so this is additive — but it is a
gameplay change and belongs behind the same authority as everything else: the server owns
it, the client predicts against the same data, and a mismatch desyncs. Ship it server-side
first and verify with the existing two-client session test before the client predicts it.

## 5. Grouping planes into hulls — SOLVED (2026-08-07)

**`planeCount` is a `u32` at offset 72 of the volume record, and volumes own CONTIGUOUS
runs of planes.** Measured, not assumed:

- Across the 154 models with exactly one volume, the u32 at offset 72 equals `nColPlanes`
  in **all 154**. No other offset in the 80 bytes does.
- Across the 234 models with two or more volumes, `sum(planeCount)` equals `nColPlanes`
  in **all 234, with zero mismatches**.

A sum matching exactly over 234 independent models is not a coincidence, and it is the
same ownership pattern sub-objects already use for vertices (`docs/02` §4.5). So the
grouping is: walk the volumes in order, each takes the next `planeCount` planes.

That is everything the conversion needs — the hull is its plane set, and the plane records
are verified (§1). **The rest of the volume header remains unread**: the documented
`int32[6]` bounding box at offset 8 does not describe these bytes (read that way the boxes
come out inverted and outside the model, measured on `CRATE1` whose true extent is known),
and the BSP child indices are unverified. None of that blocks us — the AABB is derivable
from the hull's own planes, and a flat list of convex hulls is what Rapier wants anyway.
Leave those fields raw; revisit only if a model appears where flat iteration is too slow
(the largest here has 49 volumes, so: not soon).

Models with **no** collision data at all (235 of 623) still need the honest fallback: one
AABB from the render mesh, tagged `"source": "mesh-aabb"` so it is never mistaken for
authored collision.

## 6. Sequence

1. ~~Solve the volume header~~ — **done, §5.** Grouping is contiguous runs of
   `planeCount` planes per volume.
2. Extend `file3di.mjs`: group planes into hulls, derive hull vertices, bake surface type.
3. `df2extract.mjs mission … --collision` emits `collision.json`.
4. Server: build static bodies at map load; raycast returns surface; verify with the
   two-client session test.
5. Client: same bodies for prediction, behind the room's authority.
6. Only then: player-vs-prop collision as a gameplay change, measured.

## 7. Consequences for the mission editor and user assets

The asset-scoped format above is what makes the editor tractable, so the two designs have
to be decided together.

**Every asset carries its own collision, whatever its origin.** Three producers, one
consumer:

| Origin | How hulls are produced | `source` |
|---|---|---|
| Converted DF2 prop | volumes → hulls (§1, §5) | `authored` |
| User-uploaded GLB | convex decomposition at import | `convex-decomposition` |
| Neither available | AABB from the mesh | `mesh-aabb` |

The runtime never branches on origin — it reads hulls. Only the editor's UI cares, so it
can tell an author "this asset's collision was generated, and here is what it looks like".
That is also the honest-provenance rule this project already applies to grass and canopy
data: a generated approximation must never be indistinguishable from authored data.

**Uploads need a budget, not just a parser.** Hull count and vertex count per asset are the
numbers that decide whether a community map runs, so they belong in the import step as a
hard limit with a visible readout — the same reasoning as the population-query limits in
the stats work. A user who uploads a 200k-triangle mesh should be told what its decomposed
collision costs before it reaches a server.

**Moving objects.** A vehicle is one Rapier body with the asset's hulls as its compound
collider, and the body moves; hulls are never re-derived per tick. Vehicles are also the
case where hull quality matters most — a wheel arch decomposed badly makes a tank climb
kerbs oddly — so authored DF2 hulls are worth keeping for the retail props rather than
re-decomposing them.

**On the editor base.** `pascalorg/editor` (MIT, React 19 / Next 16, three.js WebGPU, R3F,
Zustand + zundo undo, Zod schemas, plugin system, published `@pascal-app/core` and
`viewer` packages) is a close stack match to this project — same renderer, same React
generation — and its flat node dictionary with `parentId` is the right shape for a mission
tree. Two things to check before committing: it is an architectural editor, so its domain
model is sites/buildings/levels rather than terrain-plus-props, and it persists to
IndexedDB, whereas missions here have to round-trip to a server-readable file. The plugin
system is the seam to evaluate first.

`huma/3d/Path-Creator` (the Bezier path port, already packaged as `@huma/path-creator`
with runtime queries for point/direction/rotation and closest-point) maps directly onto
what a DF2 mission needs and does not yet have: vehicle routes and AI patrol paths. The
mission format has waypoints (`wpdistance`, `wpnumber` in the BMS entity struct) that
nothing has decoded yet — that is where a path editor plugs in.

## 8. Open questions worth measuring, not assuming

- Do the surface-type bits map to a **named** table (wood/metal/glass)? The numeric types
  12-17 are documented; the names are inferred from two labelled bits. The `.wav` names in
  `Df2.pff` (419 sounds) likely carry the vocabulary.
- Does collision differ **per LOD**? We read LOD 0 only; if lower LODs carry coarser
  volumes that is a free distance optimisation.
- Are volumes **hierarchical in use** (BSP descent) or a flat list? Matters only if a
  model has enough volumes for the tree to pay — the largest here is 49.
- Does anything rely on **collision planes for bullet penetration depth** rather than just
  hit/no-hit? The ballistics branch will want to know.
