// Lit textured material for the authored tree prototypes — TSL, both backends.
//
// The prototype counterpart of FoliageMaterial: same lit-then-fogged arrangement
// (atmosphere.litClass — docs/08 §8 invariant 7), same shared uniforms, same packed
// aInstance/aSeed bucket plumbing, same window-edge shrink so the far ring's grow-in
// meshes with it. What differs is colour: these trees carry authored base-colour
// textures, one for bark and one for the alpha-cut leaves, selected per vertex by the
// same `leaf` flag the procedural geometry already uses. Six vertex buffers total —
// position, normal, uv, leaf, aInstance, aSeed — comfortably inside WebGPU's eight.

import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  float,
  mix,
  modelWorldMatrix,
  positionLocal,
  texture,
  uv,
  vec4,
} from "three/tsl";
import type { Atmosphere } from "../df2/atmosphere.ts";
import {
  applyAlphaMode,
  applyCrossfade,
  handoffBand,
  instanceTone,
  windOffset,
  type FoliageAlphaMode,
  type FoliageUniforms,
} from "./FoliageMaterial.ts";
import type { Species } from "./species.ts";
import type { TreePrototype } from "./treePrototypes.ts";

export interface TreeMaterialOptions {
  prototype: TreePrototype;
  species: Species;
  alphaMode: FoliageAlphaMode;
  atmosphere: Atmosphere;
  /** The layer's shared uniforms — wind clock and the window-edge fade band. */
  uniforms: FoliageUniforms;
}

export function createTreeMaterial(options: TreeMaterialOptions): THREE.MeshStandardNodeMaterial {
  const { prototype, species, alphaMode, atmosphere, uniforms } = options;

  const Material = atmosphere.litClass(THREE.MeshStandardNodeMaterial);
  const material = new Material();
  material.name = `tree-${species.id}-${alphaMode}`;
  material.side = THREE.DoubleSide;
  material.roughness = 0.92;
  material.metalness = 0;

  const leafFlag = attribute<"float">("leaf", "float");
  const instanceData = attribute<"vec4">("aInstance", "vec4");
  const instanceOrigin = instanceData.xyz;
  const instanceScale = instanceData.w;
  const instanceSeed = attribute<"float">("aSeed", "float");

  // Base world position, shared by the wind phase and the tier crossfade. On a 25 m
  // tree the original shrink-toward-base fade read as the tree GROWING as the player
  // approached, so the handoff dissolves per pixel instead (see FoliageMaterial).
  const worldOrigin = modelWorldMatrix.mul(vec4(instanceOrigin, 1)).xyz;
  const bandPosition = handoffBand(uniforms, worldOrigin);

  material.positionNode = Fn(() => {
    // positionLocal arrives instance-transformed; offsets are relative to the plant's
    // base exactly as in FoliageMaterial, and returning a fresh position would drop
    // every instance transform on the floor.
    const local = positionLocal.toVar();
    const offset = local.sub(instanceOrigin).toVar();

    // --- Wind: leaves only, rising with height ------------------------------
    // The trunk is a bullet-stopping proxy and must not move (foliageGeometry's rule);
    // the crown sways on the shared recipe, so a mixed stand moves as one weather. The
    // sway weight is what differs from a card: height fraction squared, so the canopy
    // travels and the bole does not.
    const heightFraction = offset.y
      .div(float(species.heightMetres).mul(instanceScale).max(1e-3))
      .clamp(0, 1);
    offset.addAssign(
      windOffset(
        uniforms,
        worldOrigin,
        instanceSeed,
        heightFraction.mul(heightFraction),
        leafFlag
      )
    );

    return instanceOrigin.add(offset);
  })();

  const trunkTexel = texture(prototype.trunkTexture, uv());
  const leafTexel = texture(prototype.leafTexture, uv());
  const tone = instanceTone(instanceSeed);

  material.colorNode = mix(trunkTexel.rgb, leafTexel.rgb, leafFlag).mul(tone);
  material.opacityNode = applyCrossfade(
    mix(float(1), leafTexel.a, leafFlag),
    bandPosition,
    "near"
  );
  applyAlphaMode(material, alphaMode);

  return material;
}
