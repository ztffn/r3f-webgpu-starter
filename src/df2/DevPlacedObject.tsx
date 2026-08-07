// DevPlacedObject — drop locally-converted GLBs onto the terrain for scale
// checks: `?obj=khufu,humvee,barrel&objat=596,198` loads each from
// /assets/local/<slug>.glb (a gitignored dir; retail-derived conversions must
// never be committed) and places the first at those TEXEL coordinates, the rest
// lined up eastward. Dev instrument for asset calibration and the seed of
// mission-editor object placement — not a gameplay feature.
//
// Placement puts each model's ORIGIN on the ground, deliberately not its
// bounding-box base: DF2 props are authored with the origin at ground contact,
// and some (KHUFU's 12.7 m skirt) extend below it on purpose. Box-base resting
// would float the pyramid on its skirt.

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Heightfield } from "./Heightfield";
import { isAssetSlug } from "./config";

const DEFAULT_AT: readonly [number, number] = [512, 512];

/** `?obj=` / `?objat=`, read once per mount like every other launch-time dial. */
function readPlacement(search: string) {
  const params = new URLSearchParams(search);
  const slugs = (params.get("obj") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isAssetSlug);
  const at = (params.get("objat") ?? "").split(",").map(Number);
  const anchor: readonly [number, number] =
    at.length === 2 && at.every(Number.isFinite) ? [at[0], at[1]] : DEFAULT_AT;
  return { slugs, anchor };
}

/**
 * Release a loaded subtree's GPU resources. Shared with MissionObjects: a
 * disposal fix is invisible on screen, so two copies drift silently.
 */
export function disposeSubtree(root: THREE.Object3D) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (!m) continue;
      const std = m as THREE.MeshStandardMaterial;
      std.map?.dispose();
      m.dispose();
    }
  });
}

export function DevPlacedObject({ heightfield }: { heightfield: Heightfield }) {
  const { slugs, anchor } = useMemo(
    () => readPlacement(typeof window === "undefined" ? "" : window.location.search),
    []
  );
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.name = "dev-placed-objects";
    return g;
  }, []);
  const [scenes, setScenes] = useState<THREE.Object3D[]>([]);

  // Load once per mount. The world (and its heightfield) rebuilds on every
  // scale-dial commit, and re-downloading and re-uploading every GLB to move
  // it was both the slow path and a GPU leak — placement is the cheap effect
  // below, keyed on the heightfield.
  useEffect(() => {
    if (slugs.length === 0) return;
    let alive = true;
    const loader = new GLTFLoader();
    // Captured for the cleanup, like MissionObjects: disposal must NOT ride
    // through a setState updater — React drops updates queued on an unmounting
    // component without ever running the updater, so `setScenes(prev => ...)`
    // in the cleanup silently leaked every GLB's GPU footprint per unmount.
    let acquired: THREE.Object3D[] = [];
    Promise.all(
      slugs.map((slug) =>
        loader
          .loadAsync(`/assets/local/${slug}.glb`)
          .then((gltf) => gltf.scene)
          .catch((err) => {
            console.warn(`[DevPlacedObject] failed to load ${slug}:`, err);
            return null;
          })
      )
    ).then((loaded) => {
      const usable = loaded.filter((s): s is THREE.Group => s !== null);
      if (!alive) {
        usable.forEach(disposeSubtree);
        return;
      }
      acquired = usable;
      setScenes(usable);
    });
    return () => {
      alive = false;
      setScenes([]);
      acquired.forEach(disposeSubtree);
    };
  }, [slugs]);

  // Place (and re-place after a world rebuild): first object centred on the
  // anchor, the rest lined up eastward, spaced by bounding half-widths plus a
  // fixed gap, each resting its origin on the terrain at its own spot.
  useEffect(() => {
    let cursor = anchor[0] * heightfield.cellSize - heightfield.halfWorld;
    const anchorZ = anchor[1] * heightfield.cellSize - heightfield.halfWorld;
    let prevHalfWidth: number | null = null;
    for (const scene of scenes) {
      const box = new THREE.Box3().setFromObject(scene);
      const halfWidth = Math.max((box.max.x - box.min.x) / 2, 0.5);
      if (prevHalfWidth !== null) cursor += prevHalfWidth + 8 + halfWidth;
      scene.position.set(cursor, heightfield.sample(cursor, anchorZ), anchorZ);
      group.add(scene);
      prevHalfWidth = halfWidth;
    }
    return () => {
      group.clear();
    };
  }, [group, heightfield, scenes, anchor]);

  if (slugs.length === 0) return null;
  return <primitive object={group} />;
}
