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
import {
  allSelectableClips,
  deathClipDurationDrift,
} from "../../character/characterClips.ts";
import { measureClipSpeeds, type ClipSpeeds } from "./CharacterAnimator.ts";

const SOLDIER_URL = "/assets/characters/player1/soldier.glb";
const DRACO_PATH = "/draco/";

export interface SoldierAsset {
  /** Template scene; never added to a scene directly — clone instances. */
  readonly template: THREE.Object3D;
  readonly animations: readonly THREE.AnimationClip[];
  /** Measured once here; every animator instance shares it. */
  readonly clipSpeeds: ClipSpeeds;
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
        // Fail the load rather than warn: a silently absent clip degrades to a
        // remote gliding in idle. Consumers keep the capsule fallback.
        throw new Error(
          `soldier GLB is missing ${missing.length} expected clip(s): ${missing.join(", ")}`
        );
      }
      // The death-clip table is the only copy the server side can read, and it
      // cannot open a GLB to check it. This is the one place that has both, so a
      // re-export that changed a clip's length is caught here — where it reads as
      // stale data — rather than in the field, where it reads as a body vanishing
      // mid-fall. A warning, not a throw: refusing to load the character over it
      // would be worse than the artefact.
      const drift = deathClipDurationDrift((name) =>
        gltf.animations.find((clip) => clip.name === name)?.duration
      );
      if (drift.length > 0) {
        console.warn(
          `[soldier] death clip durations disagree with the shared table; if one now ` +
            `exceeds the flat respawn window the body will leave mid-fall: ${drift.join("; ")}`
        );
      }

      gltf.scene.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) object.frustumCulled = false;
      });
      return {
        template: gltf.scene,
        animations: gltf.animations,
        clipSpeeds: measureClipSpeeds(gltf.scene, gltf.animations),
      };
    })
    .catch((error: unknown) => {
      // A transient failure must not be memoized for the session; the next
      // caller (a later join, another V press) retries the fetch.
      cached = null;
      throw error;
    });
  return cached;
}

/** A per-instance copy that owns its skeleton but shares geometry/materials. */
export function instantiateSoldier(asset: SoldierAsset): THREE.Object3D {
  return cloneWithSkeleton(asset.template);
}
