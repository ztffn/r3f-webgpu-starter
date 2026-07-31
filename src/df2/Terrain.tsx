// Infinite chunked, LOD'd terrain renderer.
//
// DF2 terrain tiles forever — there is no map edge (docs/06 §10). So instead of
// a fixed grid over one map, this maintains a moving window of chunks centred on
// the camera. As the camera crosses a chunk boundary the window re-indexes and
// meshes are repositioned; nothing is allocated per frame.
//
// The tiling makes geometry highly reusable: chunk (cx, cz) has exactly the same
// shape as chunk (cx + period, cz), so geometries are cached by
// (wrapped chunk index, lod, skirt) and shared across every repeat on screen. A
// chunk's geometry is built in local space and placed with mesh.position.
//
// Building is BUDGETED. Chunk geometry is built on the render thread, and a cold
// window is hundreds of chunks — at LOD 0 each one is ~16.6k vertices costing five
// heightfield samples apiece, so building them all in one frame froze the tab for
// seconds. Slots are visited nearest-first and building stops when a per-frame time
// slice runs out, so the near field appears immediately and the rest fills in
// behind it. Once a tile's worth of chunks is cached there is nothing left to build.

import { useThree, useFrame } from "@react-three/fiber";
import { useMemo, useRef, useEffect } from "react";
import * as THREE from "three/webgpu";
import type { Heightfield } from "./Heightfield";
import { buildChunkGeometry } from "./terrainGeometry";
import {
  CHUNK_COUNT,
  VIEW_RADIUS_MAX_CHUNKS,
  LOD_SEGMENTS,
  LOD_DISTANCE_CHUNKS,
  FOG_FAR,
  REFERENCE_P11,
} from "./config";

/**
 * Milliseconds per frame allowed for building chunk geometry.
 *
 * A time slice rather than a count of chunks: a LOD 0 chunk costs roughly sixteen
 * times a LOD 2 one, so any fixed count is either a stall on the expensive case or
 * needlessly slow on the cheap one. This fills the window in a couple of seconds on
 * fast hardware and degrades to "slower, still responsive" on slow hardware.
 */
const BUILD_MS = 6;

interface Slot {
  mesh: THREE.Mesh;
  grass: THREE.Mesh | null;
  /** Floor proxy for the grass volume; only drawn while the eye is in the canopy. */
  grassFloor: THREE.Mesh | null;
  /** Absolute chunk indices currently displayed (can be negative / unbounded). */
  cx: number;
  cz: number;
  /** LOD whose geometry is currently assigned, or -1 for none yet. */
  lod: number;
  /** 0 once the grass shell geometry is assigned, -1 for none yet. */
  grassLod: number;
  /** Offset from the camera's chunk, fixed for the slot's lifetime. */
  dx: number;
  dz: number;
}

export interface TerrainProps {
  heightfield: Heightfield;
  material: THREE.Material;
  /**
   * Optional columnar-grass shell. Must be STABLE for the lifetime of a loaded
   * terrain — use `grassEnabled` to switch it off. Swapping this to null and back
   * rebuilds the whole geometry cache, because the slot list depends on it.
   */
  grassMaterial?: THREE.Material | null;
  /**
   * Floor proxy for the grass volume — the same march against the un-lifted
   * terrain surface. Drawn only while the eye is inside the canopy, because the
   * lifted shell is a ceiling that downward rays never cross (see GrassMaterial's
   * `floorPositionNode`). Must be as stable as `grassMaterial`.
   */
  grassFloorMaterial?: THREE.Material | null;
  /** Draw the grass shell at all. Free to toggle; affects visibility only. */
  grassEnabled?: boolean;
  /** Distance (m) beyond which the grass shell is not drawn, at the base FOV. */
  grassDistance?: number;
  /**
   * Live tallest-canopy height, metres. Read every frame rather than passed as a
   * value because the debug panel writes the canopy uniform directly without a
   * React render — the floor pass has to switch on the height actually in effect.
   */
  grassCanopyMax?: () => number;
  wireframe?: boolean;
}

export function Terrain({
  heightfield,
  material,
  grassMaterial = null,
  grassFloorMaterial = null,
  grassEnabled = true,
  grassDistance = 1100,
  grassCanopyMax,
  wireframe = false,
}: TerrainProps) {
  const { camera } = useThree();
  const camPos = useRef(new THREE.Vector3());

  const state = useMemo(() => {
    const group = new THREE.Group();
    group.name = "terrain";

    const chunkSize = heightfield.worldSize / CHUNK_COUNT;
    const lodDistances = LOD_DISTANCE_CHUNKS.map((c) => c * chunkSize);

    // Reach far enough that the fog, not the window edge, is what ends the view.
    const radius = Math.min(
      VIEW_RADIUS_MAX_CHUNKS,
      Math.max(2, Math.ceil(FOG_FAR / chunkSize))
    );

    // Geometry cache keyed by "wrappedCx,wrappedCz,lod,skirt" — shared across repeats.
    const cache = new Map<string, THREE.BufferGeometry>();
    const wrap = (c: number) => ((c % CHUNK_COUNT) + CHUNK_COUNT) % CHUNK_COUNT;
    const key = (cx: number, cz: number, lod: number, skirt: boolean) =>
      `${wrap(cx)},${wrap(cz)},${lod},${skirt ? 1 : 0}`;

    const buildGeometry = (
      cx: number,
      cz: number,
      lod: number,
      skirt: boolean
    ): THREE.BufferGeometry => {
      const k = key(cx, cz, lod, skirt);
      let geo = cache.get(k);
      if (!geo) {
        const wx = wrap(cx);
        const wz = wrap(cz);
        geo = buildChunkGeometry({
          heightfield,
          // Sample from the base tile; sample() wraps so this is the canonical
          // shape shared by every repeat of this chunk.
          ox: -heightfield.halfWorld + wx * chunkSize,
          oz: -heightfield.halfWorld + wz * chunkSize,
          size: chunkSize,
          segments: LOD_SEGMENTS[lod],
          skirt,
        });
        cache.set(k, geo);
      }
      return geo;
    };

    const cached = (cx: number, cz: number, lod: number, skirt: boolean) =>
      cache.get(key(cx, cz, lod, skirt));

    // Visit order, nearest offset first, so the build budget always spends itself
    // on the chunks closest to the camera. Fixed for the window's lifetime.
    const offsets: Array<[number, number]> = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) offsets.push([dx, dz]);
    }
    offsets.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));

    const slots: Slot[] = offsets.map(([dx, dz]) => {
      const mesh = new THREE.Mesh(undefined, material);
      mesh.frustumCulled = true;
      mesh.visible = false;
      group.add(mesh);

      // The grass shell reuses chunk geometry; the material lifts it to the canopy
      // top in the vertex stage and marches back down per fragment.
      let grass: THREE.Mesh | null = null;
      if (grassMaterial) {
        grass = new THREE.Mesh(undefined, grassMaterial);
        grass.frustumCulled = true;
        grass.renderOrder = 1;
        grass.visible = false;
        group.add(grass);
      }

      // Shares the ceiling's geometry — same chunk, same LOD 0, same cache entry.
      // Only the material differs, and only in whether the vertex is lifted.
      let grassFloor: THREE.Mesh | null = null;
      if (grassMaterial && grassFloorMaterial) {
        grassFloor = new THREE.Mesh(undefined, grassFloorMaterial);
        grassFloor.frustumCulled = true;
        grassFloor.renderOrder = 1;
        grassFloor.visible = false;
        group.add(grassFloor);
      }
      return { mesh, grass, grassFloor, cx: NaN, cz: NaN, lod: -1, grassLod: -1, dx, dz };
    });

    return {
      group,
      slots,
      buildGeometry,
      cached,
      chunkSize,
      lodDistances,
      cache,
    };
  }, [heightfield, material, grassMaterial, grassFloorMaterial]);

  useEffect(() => {
    (material as THREE.MeshStandardMaterial).wireframe = wireframe;
  }, [material, wireframe]);

  useEffect(() => {
    const { cache } = state;
    return () => {
      for (const geo of cache.values()) geo.dispose();
      cache.clear();
    };
  }, [state]);

  useFrame(() => {
    const p = camPos.current;
    camera.getWorldPosition(p);

    const { slots, buildGeometry, cached, chunkSize, lodDistances } = state;
    const half = heightfield.halfWorld;

    // NO frustum gating on building. It was added to stop the budget being spent on
    // chunks behind the camera, and it demonstrably dropped chunks that were on
    // screen: with a tall canopy, large wedges of near terrain never built at all
    // and rendered as sky. Wireframe confirmed the geometry was absent rather than
    // mis-shaded. Slots are still visited nearest-first, so the budget still favours
    // the near field; it just no longer refuses to build anything.

    // The shader stretches its distance fade by the same zoom factor, so the cull
    // has to move with it or the mesh disappears while the fade is still running.
    const p11 = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
    const grassCull = grassDistance * Math.max(1, p11 / REFERENCE_P11);

    // Height of the grass volume's ceiling, for the floor tests below.
    const canopyMax = grassCanopyMax ? grassCanopyMax() * 1.04 : 0;
    // Is the eye inside the grass volume where it stands? Conservative — uses the
    // tallest canopy on the map rather than the local one, because the canopy field
    // lives in a texture and this side only has the terrain heightfield. Erring
    // towards drawing costs frame time; erring the other way leaves a hole.
    const insideCanopy = canopyMax > 0 && p.y < heightfield.sample(p.x, p.z) + canopyMax;

    // Chunk the camera currently occupies, in absolute (unwrapped) indices.
    const camCx = Math.floor((p.x + half) / chunkSize);
    const camCz = Math.floor((p.z + half) / chunkSize);

    const deadline = performance.now() + BUILD_MS;
    let mayBuild = true;

    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k];
      const cx = camCx + slot.dx;
      const cz = camCz + slot.dz;

      const ox = -half + cx * chunkSize;
      const oz = -half + cz * chunkSize;
      const dist = Math.hypot(ox + chunkSize / 2 - p.x, oz + chunkSize / 2 - p.z);

      let lod = lodDistances.length - 1;
      for (let l = 0; l < lodDistances.length; l++) {
        if (dist <= lodDistances[l]) {
          lod = l;
          break;
        }
      }

      if (slot.cx !== cx || slot.cz !== cz) {
        slot.mesh.position.set(ox, 0, oz);
        slot.grass?.position.set(ox, 0, oz);
        slot.grassFloor?.position.set(ox, 0, oz);
        slot.cx = cx;
        slot.cz = cz;
        slot.lod = -1; // force geometry refresh for the new location
        slot.grassLod = -1;
      }

      if (slot.lod !== lod) {
        const hit = cached(cx, cz, lod, true);
        if (hit) {
          slot.mesh.geometry = hit;
          slot.lod = lod;
        } else if (mayBuild) {
          slot.mesh.geometry = buildGeometry(cx, cz, lod, true);
          slot.lod = lod;
          mayBuild = performance.now() < deadline;
        }
        // else: keep last frame's geometry (or stay hidden) and retry next frame.
      }
      slot.mesh.visible = slot.lod >= 0;

      // --- grass shell ------------------------------------------------------
      // Always LOD 0, and skirtless. The shell is lifted per vertex by the canopy
      // at that vertex, so at LOD 1-2 spacing (4-8 m) the lift was interpolated
      // across quads far coarser than the 2 m canopy texel: it clipped column tops
      // where the canopy peaked between vertices and overhung bare ground where it
      // dipped, which is the floating-grass fringe in docs/07 §9. Pinning the shell
      // to LOD 0 makes its vertex spacing match the canopy texel, and also stops
      // the artifact changing as the terrain chunk switches LOD underneath it.
      if (slot.grass) {
        const want = grassEnabled && dist < grassCull;
        if (want && slot.grassLod !== 0) {
          const hit = cached(cx, cz, 0, false);
          if (hit) {
            slot.grass.geometry = hit;
            slot.grassLod = 0;
          } else if (mayBuild) {
            slot.grass.geometry = buildGeometry(cx, cz, 0, false);
            slot.grassLod = 0;
            mayBuild = performance.now() < deadline;
          }
        }
        slot.grass.visible = want && slot.grassLod === 0;

        // The floor rides on the ceiling's geometry and its readiness — same chunk,
        // same LOD 0 cache entry — so it needs no build budget of its own.
        //
        // WHERE the floor is needed. The ceiling proxy fails a pixel only when the ray
        // reaches the ground without ever crossing the canopy top — which happens
        // exactly where the terrain plus its canopy stands ABOVE the eye. Look
        // downhill or across a valley and the ray descends through the canopy top on
        // the way in, so the ceiling covers it and the floor is pure overdraw.
        //
        // Two conditions, both measured, and both needed:
        //
        //   insideCanopy   — the eye is in the grass. Without this the floor is drawn
        //                    while standing for every chunk that has a peak above eye
        //                    level, which measured 29.0 ms against 16.0 ms at the
        //                    docs/09 §1 vantage. Nearly doubling the standing frame is
        //                    not worth it for a case that has not been shown to fail.
        //   chunk max > eye — drops the downhill half of the world when prone. Worth
        //                    31.5 ms against 37.5 ms on its own.
        //
        // KNOWN GAP, unverified: standing and looking at an uphill slope that rises
        // above eye level, the ray can reach ground without crossing the canopy top, so
        // the ceiling has no fragment and `insideCanopy` suppresses the floor. Whether
        // that actually shows as missing grass has NOT been tested — check the hit mask
        // on a steep uphill before assuming either way, and read docs/08 §8 invariant 6
        // first, because missing grass is a fairness bug and not a cosmetic one.
        //
        // The real answer is to stop needing a second pass at all: extend the ceiling
        // proxy downward at its silhouette so it is a closed surface, and every ray has
        // an entry fragment from any viewpoint. That is one march, no gate, no cases.
        if (slot.grassFloor) {
          const top = slot.grass.geometry.boundingBox?.max.y;
          const chunkAboveEye = top === undefined || top + canopyMax > p.y;
          slot.grassFloor.geometry = slot.grass.geometry;
          slot.grassFloor.visible = slot.grass.visible && insideCanopy && chunkAboveEye;
        }
      }
    }
  });

  return <primitive object={state.group} />;
}
