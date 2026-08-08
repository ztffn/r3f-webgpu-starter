// Loads the authored tree prototypes and turns them into cell-bucket templates.
//
// The runtime half of tools/vegetation/extract-prototypes.mjs: fetches the single
// prototypes.glb (unit-height trees, trunk and leaf primitives split by material),
// merges each tree into the bucket layout the foliage renderer already speaks —
// non-indexed position/normal/uv plus the per-vertex `leaf` flag — and returns the two
// base-colour textures per tree. Scaling back to metres happens in `buildTreeTemplate`
// from species.heightMetres, which is the one place a tree's size is authored.
//
// Resolves to null when the assets are absent: prototype species then simply do not
// grow buckets, and the procedural species carry the layer alone.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Species } from "./species.ts";

export interface TreePrototype {
  /** Unit height, non-indexed, attributes: position, normal, uv, leaf. */
  geometry: THREE.BufferGeometry;
  trunkTexture: THREE.Texture;
  leafTexture: THREE.Texture;
  triangleCount: number;
}

export interface TreePrototypes {
  byId: ReadonlyMap<string, TreePrototype>;
  dispose(): void;
}

function mergeTree(
  trunk: THREE.Mesh,
  leaves: THREE.Mesh
): { geometry: THREE.BufferGeometry; triangleCount: number } {
  const parts = [
    { mesh: trunk, leaf: 0 },
    { mesh: leaves, leaf: 1 },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const leafFlags: number[] = [];
  for (const part of parts) {
    // Non-indexed to match the template contract: bucket geometries are assembled by
    // copying attributes only, so an index buffer would be silently dropped.
    const source = part.mesh.geometry.index
      ? part.mesh.geometry.toNonIndexed()
      : part.mesh.geometry;
    const position = source.getAttribute("position");
    const normal = source.getAttribute("normal");
    const uv = source.getAttribute("uv");
    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      uvs.push(uv.getX(i), uv.getY(i));
      leafFlags.push(part.leaf);
    }
    if (source !== part.mesh.geometry) source.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("leaf", new THREE.Float32BufferAttribute(leafFlags, 1));
  return { geometry, triangleCount: positions.length / 9 };
}

export async function loadTreePrototypes(
  url = "/assets/vegetation/prototypes/prototypes.glb"
): Promise<TreePrototypes | null> {
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(url);
  } catch (error) {
    console.warn("[foliage] tree prototypes unavailable, prototype species disabled:", error);
    return null;
  }

  const byId = new Map<string, TreePrototype>();
  // A two-primitive glTF mesh arrives as a Group whose children carry the materials;
  // the leaf primitive is identified by its material name, which the extractor set.
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Group) || object.children.length < 2) return;
    const meshes = object.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
    if (meshes.length < 2) return;
    const leaves = meshes.find((m) => (m.material as THREE.Material).name.endsWith("-leaves"));
    const trunk = meshes.find((m) => (m.material as THREE.Material).name.endsWith("-trunk"));
    if (!leaves || !trunk) return;

    const trunkTexture = (trunk.material as THREE.MeshStandardMaterial).map;
    const leafTexture = (leaves.material as THREE.MeshStandardMaterial).map;
    if (!trunkTexture || !leafTexture) return;
    // BOTH samplers must wrap: bark uvs tile beyond [0,1], and the pack authors its
    // leaf uvs in v ∈ [1,2] outright — clamped, the whole crown samples one transparent
    // edge row and vanishes (the impostor bake hit exactly that).
    trunkTexture.wrapS = THREE.RepeatWrapping;
    trunkTexture.wrapT = THREE.RepeatWrapping;
    leafTexture.wrapS = THREE.RepeatWrapping;
    leafTexture.wrapT = THREE.RepeatWrapping;
    trunkTexture.anisotropy = 4;
    leafTexture.anisotropy = 4;

    const merged = mergeTree(trunk, leaves);
    byId.set(object.name, {
      geometry: merged.geometry,
      trunkTexture,
      leafTexture,
      triangleCount: merged.triangleCount,
    });
  });

  if (byId.size === 0) {
    console.warn("[foliage] prototypes.glb contained no recognisable trees");
    return null;
  }
  return {
    byId,
    dispose() {
      for (const prototype of byId.values()) {
        prototype.geometry.dispose();
        prototype.trunkTexture.dispose();
        prototype.leafTexture.dispose();
      }
    },
  };
}

/**
 * A species-sized template for the cell renderer: the unit prototype scaled to the
 * species' authored height, with bounds fit to the scaled vertices.
 */
export function buildTreeTemplate(
  prototype: TreePrototype,
  species: Species
): { geometry: THREE.BufferGeometry; triangleCount: number } {
  const geometry = prototype.geometry.clone();
  const h = species.heightMetres;
  geometry.scale(h, h, h);
  geometry.computeBoundingSphere();
  return { geometry, triangleCount: prototype.triangleCount };
}
