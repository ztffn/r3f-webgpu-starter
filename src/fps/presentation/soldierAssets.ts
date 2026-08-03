// Loads the soldier character GLB once and shares it.
//
// The runtime asset is the Draco/WebP-compressed export in
// public/assets/characters/player1/ (the raw 272 MB source stays out of the
// repo); the decoder is self-hosted under public/draco/ so nothing depends on
// a CDN. Instances must be cloned through SkeletonUtils — a plain .clone()
// shares the skeleton and every copy animates in lockstep. Clip names are
// validated against the vocabulary the animator can ask for, so a renamed
// clip fails loudly at load rather than as a silent T-pose in the field.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { clone as cloneWithSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { allSelectableClips } from "./characterClips.ts";

const SOLDIER_URL = "/assets/characters/player1/soldier.glb";
const DRACO_PATH = "/draco/";

export interface SoldierAsset {
  /** Template scene; never added to a scene directly — clone instances. */
  readonly template: THREE.Object3D;
  readonly animations: readonly THREE.AnimationClip[];
}

let cached: Promise<SoldierAsset> | null = null;

export function loadSoldier(): Promise<SoldierAsset> {
  cached ??= new GLTFLoader()
    .setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO_PATH))
    .loadAsync(SOLDIER_URL)
    .then((gltf) => {
      const names = new Set(gltf.animations.map((clip) => clip.name));
      const missing = allSelectableClips().filter((name) => !names.has(name));
      if (missing.length > 0) {
        console.warn(`soldier GLB is missing ${missing.length} expected clip(s):`, missing);
      }
      gltf.scene.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) object.frustumCulled = false;
      });
      return { template: gltf.scene, animations: gltf.animations };
    });
  return cached;
}

/** A per-instance copy that owns its skeleton but shares geometry/materials. */
export function instantiateSoldier(asset: SoldierAsset): THREE.Object3D {
  return cloneWithSkeleton(asset.template);
}
