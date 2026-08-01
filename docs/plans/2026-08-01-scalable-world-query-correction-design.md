# Scalable world-query correction

## Problem

The pooled projectile integrator is bounded, but the playable scene connected
each 120 Hz swept segment to a recursive Three.js raycast over the visual
terrain group. That group contains hundreds of terrain chunks plus shader-only
grass proxy meshes. Query cost therefore scales with renderer complexity and
active projectile lifetime. It also gives gameplay the wrong collision
geometry: grass shells and the camera-facing inside-canopy cap are render
proxies, not physical terrain.

The existing automatic-fire tests used either a null query or an immediately
hit cloth plane. They proved pool capacity and fixed-step determinism, but not
the required end-to-end collision workload.

## Chosen architecture

Keep `WorldQuery` as the gameplay seam and compose two purpose-built backends:

1. `HeightfieldWorldQuery` intersects swept segments directly with the
   canonical CPU `Heightfield`. It traverses crossed heightfield cells, solves
   the bilinear surface within each cell, refines the first contact, and obtains
   the contact normal from the same heightfield. It never reads terrain meshes,
   LOD state, grass geometry, materials, or the scene graph.
2. `ThreeWorldQuery` remains an adapter for explicitly registered prototype
   colliders, but indexes registration bounds in a two-dimensional uniform
   grid. A ray traverses grid cells and asks Three.js to test only nearby
   registered roots. Terrain is never registered here.
3. `CompositeWorldQuery` returns the nearer result from the analytic terrain
   and indexed-collider backends. Shots and the optical rangefinder share this
   composite result.

The scene may pass the existing heightfield into the composite adapter. That is
the only terrain/FPS wiring change. Terrain rendering remains free to change
LOD schedules, grass proxies, materials, and shaders without changing gameplay
collision or its cost.

## Projectile lifetime

Every ballistic weapon definition supplies a finite maximum flight lifetime in
addition to maximum path length. A projectile resolves at the first of impact,
path exhaustion, or lifetime exhaustion. The prototype sniper uses 3.5 seconds:
long enough for the current 1,300 m `.308`, 5.56 mm, and `.50 BMG` acceptance
shots, while preventing diagnostic 9 mm misses from remaining live for roughly
27 seconds.

The client simulates its local authoritative/predicted rounds. Remote rounds
remain bounded presentation events; a future server authority can run the same
pooled solver against a server-side implementation of `WorldQuery`.

## Alternatives rejected

- Pruning the renderer's terrain group reduces mesh count but still couples
  gameplay to LOD and shader proxy geometry, so both cost and semantics remain
  unstable.
- Adding a mesh BVH to visual terrain improves triangle lookup but still makes
  gameplay depend on transient LOD meshes and duplicates the canonical CPU
  heightfield.
- Rapier scene queries remain viable behind `WorldQuery` when character and
  vehicle physics justify that dependency. It is unnecessary for deterministic
  bullet/heightfield intersection in this slice.

## Verification

- Analytic terrain hits agree with flat, sloped, wrapped, and long-range
  heightfield fixtures; above-terrain segments miss.
- Render-only meshes cannot affect terrain collision.
- Spatial indexing returns the same nearest registered collider as direct
  raycasting while examining only crossed-cell candidates.
- A low-velocity 2,000 m miss resolves at its authored lifetime.
- The 16/32-player 600 RPM acceptance load and 32-player 900 RPM stress load run
  against the real analytic heightfield query, include misses, publish query
  metrics, exhaust neither projectile nor event capacity, and allocate no
  projectile objects in the fixed-step loop.
- The FPS suite, TypeScript build, and production bundle pass without modifying
  terrain, grass, LOD, or shader implementation files.
