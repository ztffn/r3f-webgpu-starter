// Loads and caches the authored first-person rig: the shared hands GLB and the ten
// weapon GLBs, decoded through the committed Draco and Basis transcoders.
//
// The hands load once and every weapon is cached on first equip, because switching
// weapons is a keypress and re-downloading 4 MB per press is not acceptable. Clip names
// are validated against what the presentation layer can ask for, so a bad re-export
// fails loudly at load instead of as a weapon that silently never animates.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import {
  handClipNamesFor,
  weaponClipNamesFor,
  type RigWeaponKey,
  type WeaponPresentationDefinition,
} from "./WeaponPresentationDefinition.ts";

const ASSET_ROOT = "/assets/weapons/";
const DRACO_PATH = "/draco/";
/** Self-hosted: the page CSP blocks a CDN, which is why these are committed. */
const BASIS_PATH = "/basis/";

/** The bone every weapon root parents onto, and the whole of the attach contract. */
export const ATTACH_BONE = "R_wrist";

export interface LoadedRigAsset {
  readonly scene: THREE.Object3D;
  readonly animations: readonly THREE.AnimationClip[];
  readonly clips: ReadonlyMap<string, THREE.AnimationClip>;
}

let loader: GLTFLoader | null = null;
let handsPromise: Promise<LoadedRigAsset> | null = null;
const weaponPromises = new Map<RigWeaponKey, Promise<LoadedRigAsset>>();

/**
 * One loader for the whole session.
 *
 * KTX2Loader must be told what the renderer supports before it can pick a transcode
 * target, and that check needs the live renderer — which is why this takes one rather
 * than being a bare module constant.
 */
function rigLoader(renderer: THREE.WebGPURenderer): GLTFLoader {
  if (!loader) {
    const ktx2 = new KTX2Loader().setTranscoderPath(BASIS_PATH);
    ktx2.detectSupport(renderer);
    loader = new GLTFLoader()
      .setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO_PATH))
      .setKTX2Loader(ktx2);
  }
  return loader;
}

function indexClips(animations: readonly THREE.AnimationClip[]): Map<string, THREE.AnimationClip> {
  return new Map(animations.map((clip) => [clip.name, clip]));
}

function assertClips(label: string, clips: ReadonlyMap<string, unknown>, expected: string[]): void {
  const missing = expected.filter((name) => !clips.has(name));
  if (missing.length === 0) return;
  // Throw rather than warn. A missing clip degrades to a weapon frozen in bind pose
  // holding a rifle that never cycles, which reads as a rendering bug rather than as
  // stale data — the same reasoning soldierAssets.ts applies to the character.
  throw new Error(`${label} is missing ${missing.length} clip(s): ${missing.join(", ")}`);
}

/**
 * The shared hands skeleton, with every weapon's hand clips.
 *
 * Deliberately NOT cloned per consumer. Exactly one first-person rig exists at a time —
 * `?scene=weapon` and `?scene=scope` are alternative routes, never simultaneous — so a
 * template-and-clone scheme would buy nothing and would make disposal ambiguous, since
 * clones share geometry and materials with the template they came from.
 */
export function loadHands(renderer: THREE.WebGPURenderer): Promise<LoadedRigAsset> {
  handsPromise ??= rigLoader(renderer)
    .loadAsync(`${ASSET_ROOT}hands.glb`)
    .then((gltf) => {
      if (!gltf.scene.getObjectByName(ATTACH_BONE)) {
        throw new Error(`hands.glb has no "${ATTACH_BONE}" bone; no weapon could attach`);
      }
      return { scene: gltf.scene, animations: gltf.animations, clips: indexClips(gltf.animations) };
    });
  return handsPromise;
}

/** One weapon, cached for the session so a weapon-switch keypress costs nothing. */
export function loadWeapon(
  renderer: THREE.WebGPURenderer,
  definition: WeaponPresentationDefinition
): Promise<LoadedRigAsset> {
  const key = definition.rigKey;
  let promise = weaponPromises.get(key);
  if (!promise) {
    promise = rigLoader(renderer)
      .loadAsync(`${ASSET_ROOT}${key}.glb`)
      .then((gltf) => {
        const clips = indexClips(gltf.animations);
        assertClips(`${key}.glb`, clips, weaponClipNamesFor(definition));
        return { scene: gltf.scene, animations: gltf.animations, clips };
      });
    weaponPromises.set(key, promise);
  }
  return promise;
}

/** Validates that the hands carry every clip this weapon will ask them for. */
export function assertHandClips(
  hands: LoadedRigAsset,
  definition: WeaponPresentationDefinition
): void {
  assertClips("hands.glb", hands.clips, handClipNamesFor(definition));
}
