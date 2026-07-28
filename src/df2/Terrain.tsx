// Infinite chunked, LOD'd terrain renderer.
//
// DF2 terrain tiles forever — there is no map edge (docs/06 §10). So instead of
// a fixed grid over one map, this maintains a moving window of chunks centred on
// the camera. As the camera crosses a chunk boundary the window re-indexes and
// meshes are repositioned; nothing is allocated per frame.
//
// The tiling makes geometry highly reusable: chunk (cx, cz) has exactly the same
// shape as chunk (cx + period, cz), so geometries are cached by
// (wrapped chunk index, lod) and shared across every repeat on screen. A chunk's
// geometry is built in local space and placed with mesh.position.

import { useThree, useFrame } from "@react-three/fiber";
import { useMemo, useRef, useEffect } from "react";
import * as THREE from "three/webgpu";
import type { Heightfield } from "./Heightfield";
import { buildChunkGeometry } from "./terrainGeometry";
import {
  CHUNK_COUNT,
  VIEW_RADIUS_CHUNKS,
  LOD_SEGMENTS,
  LOD_DISTANCE_CHUNKS,
} from "./config";

interface Slot {
  mesh: THREE.Mesh;
  grass: THREE.Mesh | null;
  /** Absolute chunk indices currently displayed (can be negative / unbounded). */
  cx: number;
  cz: number;
  lod: number;
}

export interface TerrainProps {
  heightfield: Heightfield;
  material: THREE.Material;
  /** Optional columnar-grass shell drawn over the same chunk geometry. */
  grassMaterial?: THREE.Material | null;
  /** Distance (m) beyond which the grass shell is not drawn at all. */
  grassDistance?: number;
  wireframe?: boolean;
}

export function Terrain({
  heightfield,
  material,
  grassMaterial = null,
  grassDistance = 700,
  wireframe = false,
}: TerrainProps) {
  const { camera } = useThree();
  const camPos = useRef(new THREE.Vector3());

  const state = useMemo(() => {
    const group = new THREE.Group();
    group.name = "terrain";

    const chunkSize = heightfield.worldSize / CHUNK_COUNT;
    const lodDistances = LOD_DISTANCE_CHUNKS.map((c) => c * chunkSize);
    // Geometry cache keyed by "wrappedCx,wrappedCz,lod" — shared across repeats.
    const cache = new Map<string, THREE.BufferGeometry>();

    const getGeometry = (cx: number, cz: number, lod: number): THREE.BufferGeometry => {
      const wx = ((cx % CHUNK_COUNT) + CHUNK_COUNT) % CHUNK_COUNT;
      const wz = ((cz % CHUNK_COUNT) + CHUNK_COUNT) % CHUNK_COUNT;
      const key = `${wx},${wz},${lod}`;
      let geo = cache.get(key);
      if (!geo) {
        geo = buildChunkGeometry({
          heightfield,
          // Sample from the base tile; sample() wraps so this is the canonical
          // shape shared by every repeat of this chunk.
          ox: -heightfield.halfWorld + wx * chunkSize,
          oz: -heightfield.halfWorld + wz * chunkSize,
          size: chunkSize,
          segments: LOD_SEGMENTS[lod],
        });
        cache.set(key, geo);
      }
      return geo;
    };

    const span = VIEW_RADIUS_CHUNKS * 2 + 1;
    const slots: Slot[] = [];
    for (let k = 0; k < span * span; k++) {
      const mesh = new THREE.Mesh(undefined, material);
      mesh.frustumCulled = true;
      group.add(mesh);

      // The grass shell reuses the terrain chunk geometry; the material lifts it
      // to the canopy top in the vertex stage and marches back down per fragment.
      let grass: THREE.Mesh | null = null;
      if (grassMaterial) {
        grass = new THREE.Mesh(undefined, grassMaterial);
        grass.frustumCulled = true;
        grass.renderOrder = 1;
        group.add(grass);
      }
      slots.push({ mesh, grass, cx: NaN, cz: NaN, lod: -1 });
    }

    return { group, slots, getGeometry, chunkSize, lodDistances, cache };
  }, [heightfield, material, grassMaterial]);

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

    const { slots, getGeometry, chunkSize, lodDistances } = state;
    const half = heightfield.halfWorld;

    // Chunk the camera currently occupies, in absolute (unwrapped) indices.
    const camCx = Math.floor((p.x + half) / chunkSize);
    const camCz = Math.floor((p.z + half) / chunkSize);

    let k = 0;
    for (let dz = -VIEW_RADIUS_CHUNKS; dz <= VIEW_RADIUS_CHUNKS; dz++) {
      for (let dx = -VIEW_RADIUS_CHUNKS; dx <= VIEW_RADIUS_CHUNKS; dx++, k++) {
        const slot = slots[k];
        const cx = camCx + dx;
        const cz = camCz + dz;

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
          slot.cx = cx;
          slot.cz = cz;
          slot.lod = -1; // force geometry refresh for the new location
        }
        if (slot.lod !== lod) {
          const geo = getGeometry(cx, cz, lod);
          slot.mesh.geometry = geo;
          if (slot.grass) slot.grass.geometry = geo;
          slot.lod = lod;
        }
        // Grass is only drawn where columns are actually resolvable.
        if (slot.grass) slot.grass.visible = dist < grassDistance;
      }
    }
  });

  return <primitive object={state.group} />;
}
