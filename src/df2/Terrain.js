// Chunked, LOD'd terrain renderer (Phase 1).
//
// One THREE.Mesh per chunk, all sharing one TSL terrain material. Each frame,
// every chunk picks a LOD from its distance to the camera; geometries are built
// lazily and cached per (chunk, lod), so a LOD change is just a geometry swap
// with no per-frame allocation
// (03-terrain-and-grass-rendering-design.md §2, 05-...md §4).

import { useThree, useFrame } from "@react-three/fiber";
import { useMemo, useRef, useEffect } from "react";
import * as THREE from "three/webgpu";
import { Heightfield } from "./Heightfield.js";
import { buildChunkGeometry } from "./terrainGeometry.js";
import { createTerrainMaterial } from "./TerrainMaterial.js";
import {
  CHUNK_COUNT,
  CHUNK_SIZE,
  HALF_WORLD,
  LOD_SEGMENTS,
  LOD_DISTANCES,
} from "./config.js";

export function Terrain({ wireframe = false }) {
  const { camera } = useThree();
  const camPos = useRef(new THREE.Vector3());

  const state = useMemo(() => {
    const heightfield = new Heightfield();
    const material = createTerrainMaterial();
    const group = new THREE.Group();
    group.name = "terrain";

    const getGeometry = (chunk, lod) => {
      let geo = chunk.cache.get(lod);
      if (!geo) {
        geo = buildChunkGeometry({
          heightfield,
          ox: chunk.ox,
          oz: chunk.oz,
          size: CHUNK_SIZE,
          segments: LOD_SEGMENTS[lod],
        });
        chunk.cache.set(lod, geo);
      }
      return geo;
    };

    const chunks = [];
    const coarsest = LOD_SEGMENTS.length - 1;
    for (let cz = 0; cz < CHUNK_COUNT; cz++) {
      for (let cx = 0; cx < CHUNK_COUNT; cx++) {
        const ox = -HALF_WORLD + cx * CHUNK_SIZE;
        const oz = -HALF_WORLD + cz * CHUNK_SIZE;
        const mesh = new THREE.Mesh(undefined, material);
        const chunk = {
          ox,
          oz,
          centerX: ox + CHUNK_SIZE / 2,
          centerZ: oz + CHUNK_SIZE / 2,
          mesh,
          cache: new Map(),
          currentLod: -1,
        };
        // Start every chunk at the cheapest LOD; useFrame refines from there.
        mesh.geometry = getGeometry(chunk, coarsest);
        chunk.currentLod = coarsest;
        group.add(mesh);
        chunks.push(chunk);
      }
    }

    return { heightfield, material, group, chunks, getGeometry };
  }, []);

  // Keep material wireframe in sync with the prop.
  useEffect(() => {
    state.material.wireframe = wireframe;
  }, [state, wireframe]);

  // Dispose GPU resources on unmount.
  useEffect(() => {
    return () => {
      for (const chunk of state.chunks) {
        for (const geo of chunk.cache.values()) geo.dispose();
      }
      state.material.dispose();
    };
  }, [state]);

  useFrame(() => {
    const p = camPos.current;
    camera.getWorldPosition(p);
    for (const chunk of state.chunks) {
      const dx = chunk.centerX - p.x;
      const dz = chunk.centerZ - p.z;
      const dist = Math.hypot(dx, dz);

      let lod = LOD_DISTANCES.length - 1;
      for (let l = 0; l < LOD_DISTANCES.length; l++) {
        if (dist <= LOD_DISTANCES[l]) {
          lod = l;
          break;
        }
      }

      if (lod !== chunk.currentLod) {
        chunk.mesh.geometry = state.getGeometry(chunk, lod);
        chunk.currentLod = lod;
      }
    }
  });

  return <primitive object={state.group} />;
}
