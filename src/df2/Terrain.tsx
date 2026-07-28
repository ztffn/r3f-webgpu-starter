// Chunked, LOD'd terrain renderer.
//
// One THREE.Mesh per chunk, all sharing one TSL terrain material. Each frame,
// every chunk picks a LOD from its distance to the camera; geometries are built
// lazily and cached per (chunk, lod), so a LOD change is just a geometry swap
// with no per-frame allocation
// (docs/03-terrain-and-grass-rendering-design.md §2, docs/05-...md §4).
//
// Chunk extent is derived from the heightfield, so the same code renders a 1 km
// synthetic field and a ~2 km extracted DF map.

import { useThree, useFrame } from "@react-three/fiber";
import { useMemo, useRef, useEffect } from "react";
import * as THREE from "three/webgpu";
import type { Heightfield } from "./Heightfield";
import { buildChunkGeometry } from "./terrainGeometry";
import { CHUNK_COUNT, LOD_SEGMENTS, LOD_DISTANCE_CHUNKS } from "./config";

interface Chunk {
  ox: number;
  oz: number;
  centerX: number;
  centerZ: number;
  mesh: THREE.Mesh;
  cache: Map<number, THREE.BufferGeometry>;
  currentLod: number;
}

export interface TerrainProps {
  heightfield: Heightfield;
  material: THREE.Material;
  wireframe?: boolean;
}

export function Terrain({ heightfield, material, wireframe = false }: TerrainProps) {
  const { camera } = useThree();
  const camPos = useRef(new THREE.Vector3());

  const state = useMemo(() => {
    const group = new THREE.Group();
    group.name = "terrain";
    const chunkSize = heightfield.worldSize / CHUNK_COUNT;
    const half = heightfield.halfWorld;
    const lodDistances = LOD_DISTANCE_CHUNKS.map((c) => c * chunkSize);

    const getGeometry = (chunk: Chunk, lod: number): THREE.BufferGeometry => {
      let geo = chunk.cache.get(lod);
      if (!geo) {
        geo = buildChunkGeometry({
          heightfield,
          ox: chunk.ox,
          oz: chunk.oz,
          size: chunkSize,
          segments: LOD_SEGMENTS[lod],
        });
        chunk.cache.set(lod, geo);
      }
      return geo;
    };

    const chunks: Chunk[] = [];
    const coarsest = LOD_SEGMENTS.length - 1;
    for (let cz = 0; cz < CHUNK_COUNT; cz++) {
      for (let cx = 0; cx < CHUNK_COUNT; cx++) {
        const ox = -half + cx * chunkSize;
        const oz = -half + cz * chunkSize;
        const mesh = new THREE.Mesh(undefined, material);
        const chunk: Chunk = {
          ox,
          oz,
          centerX: ox + chunkSize / 2,
          centerZ: oz + chunkSize / 2,
          mesh,
          cache: new Map(),
          currentLod: coarsest,
        };
        // Start every chunk at the cheapest LOD; useFrame refines from there.
        mesh.geometry = getGeometry(chunk, coarsest);
        group.add(mesh);
        chunks.push(chunk);
      }
    }

    return { group, chunks, getGeometry, lodDistances };
  }, [heightfield, material]);

  // Keep material wireframe in sync with the prop.
  useEffect(() => {
    (material as THREE.MeshStandardMaterial).wireframe = wireframe;
  }, [material, wireframe]);

  // Dispose cached geometries when the heightfield changes or on unmount.
  useEffect(() => {
    const { chunks } = state;
    return () => {
      for (const chunk of chunks) {
        for (const geo of chunk.cache.values()) geo.dispose();
      }
    };
  }, [state]);

  useFrame(() => {
    const p = camPos.current;
    camera.getWorldPosition(p);
    const { chunks, lodDistances, getGeometry } = state;
    for (const chunk of chunks) {
      const dist = Math.hypot(chunk.centerX - p.x, chunk.centerZ - p.z);

      let lod = lodDistances.length - 1;
      for (let l = 0; l < lodDistances.length; l++) {
        if (dist <= lodDistances[l]) {
          lod = l;
          break;
        }
      }

      if (lod !== chunk.currentLod) {
        chunk.mesh.geometry = getGeometry(chunk, lod);
        chunk.currentLod = lod;
      }
    }
  });

  return <primitive object={state.group} />;
}
