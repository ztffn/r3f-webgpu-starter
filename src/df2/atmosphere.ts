// The one call every scene material makes: grade the colour, then fog it, in that order.
//
// Existing as a module is the point. The ordering rule was written out per material, so
// terrain and the relief march each got it right and everything else got nothing at all —
// the blade layer turned fog off on reasoning that stopped being true, and a building
// added tomorrow would render at full contrast against hazed terrain with no line of code
// looking wrong. A material now asks for an Atmosphere and cannot compose it incorrectly.
//
// TWO ATTACHMENT POINTS, because there are two kinds of material and only one was served.
// `shade` goes on `colorNode` and is right for UNLIT geometry against the pre-shaded
// colormap. `shadeLit` goes on the OUTPUT, after lighting, and is the only correct place
// for anything the scene's lights touch: fogging albedo and then lighting the fog is
// visibly wrong (docs/08 §8 invariant 7).

import { positionWorld, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import type { ColorGrade } from "./colorGrade";
import type { Fog } from "./fog";

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeArg = any;

export interface Atmosphere {
  /**
   * The fog alone — its LIVE uniforms, for debug views that read out the range they are
   * being fogged by. Deliberately the only half exposed: a scene material reaching past
   * `shade` is reaching for the ordering bug this module exists to prevent, and the grade
   * had no caller at all.
   */
  fog: Fog;
  /**
   * Shade a linear RGB node as scene geometry.
   *
   * GRADED BEFORE FOGGED, and that is not interchangeable. The fog colour is part of the
   * weather preset and already carries the hour, so grading it a second time pushes the
   * horizon away from the sky it is supposed to meet — the seam that makes a sky swap
   * read as a mistake rather than as an hour of the day.
   *
   * `worldPos` defaults to the fragment's own world position, which is right for
   * ordinary geometry. Pass it explicitly only when the shaded point is NOT where the
   * fragment was rasterised: the relief march has a hit position hundreds of metres from
   * its shell, and using the shell's depth washed near grass pale with fog it should
   * never have received.
   */
  shade: (rgb: NodeArg, worldPos?: NodeArg) => NodeArg;
  /**
   * A LIT material class that shades AFTER its lighting.
   *
   * A SUBCLASS RATHER THAN AN ASSIGNMENT, and the alternative is worth recording because
   * it looks correct and is not. `material.outputNode = vec4(shade(output.rgb), output.a)`
   * reads right — `NodeMaterial` does assign the post-lighting colour to `output` before
   * consulting `outputNode` — but `output`'s declared node type is the literal string
   * "output", resolved to the builder's real type only mid-build. Swizzling it never
   * narrows, so `vec4(output.rgb, output.a)` asks `vec4()` for five components and three
   * rejects the whole graph: "Length of parameters exceeds maximum length of function
   * 'vec4()'". The scene then renders BLACK with no line of code looking wrong, and
   * `vec4(output)` first does not fix it. `setupOutput` is three's own documented
   * extension point and its parameter is a real vec4, so the swizzles resolve.
   *
   * `fog` is forced off in the constructor, not left to the caller. Three's linear scene
   * fog is still declared for anything on the automatic path, so leaving it on is not a
   * no-op — it is a second, differently-coloured fog fading to a constant while the
   * terrain beside it fades to the sky. One decision, one place.
   *
   * THE GRADE GOES POST-LIGHTING TOO, deliberately. It is a global `.trn` look — tint,
   * gamma, saturation — simulated per material, so the lit analogue of "grade the
   * pre-shaded colormap" is "grade the lit result". Grading albedo instead would put lit
   * surfaces on a different curve from the terrain they stand on.
   *
   * Cached per base class, which also keeps the pipeline cache honest: a shaded and an
   * unshaded material of the same base are different CLASSES, so they cannot share a
   * compiled pipeline the way an instance-patched method would let them.
   *
   * NOT for `KHR_materials_unlit` surfaces. DF2's `FlatLit` materials (5.8% of the
   * corpus) skip lighting by design and want `shade` on `colorNode` like the terrain.
   */
  litClass: <T extends NodeMaterialClass>(Base: T) => T;
}

/** Any concrete node-material constructor — what `litClass` decorates. */
type NodeMaterialClass = new (...args: never[]) => THREE.NodeMaterial;

export function createAtmosphere(grade: ColorGrade, fog: Fog): Atmosphere {
  const shade = (rgb: NodeArg, worldPos?: NodeArg): NodeArg =>
    fog.apply(grade.apply(rgb), worldPos ?? positionWorld);

  const cache = new Map<NodeMaterialClass, NodeMaterialClass>();
  const litClass = <T extends NodeMaterialClass>(Base: T): T => {
    const cached = cache.get(Base);
    if (cached) return cached as T;
    const Shaded = class extends (Base as NodeMaterialClass) {
      constructor(...args: never[]) {
        super(...args);
        this.fog = false;
      }
      setupOutput(builder: NodeArg, outputNode: NodeArg): NodeArg {
        // A VAR, THEN A SWIZZLE ASSIGNMENT — not `vec4(shade(rgb), alpha)`.
        //
        // TSL node types resolve during the build, not when the graph is written. The
        // node arriving here is `vec4(light, alpha).max(0)`, and `.max()` is a math node
        // whose width is only known once a builder asks. Swizzling it therefore does not
        // narrow: `vec4(shade(outputNode.rgb), outputNode.a)` hands `vec4()` more than
        // four components and three rejects the entire graph with "Length of parameters
        // exceeds maximum length of function 'vec4()'" — after which the scene renders
        // BLACK with no line of code looking wrong. `toVar()` forces a declared vec4, so
        // the swizzles below are real swizzles on a known type.
        //
        // Alpha is never touched: the atmosphere changes what colour a surface is, never
        // whether it is there. A cutout leaf that went opaque with distance would be a
        // concealment change (docs/08 §8 invariant 6), not a fog one.
        const shaded = vec4(outputNode).toVar();
        shaded.rgb.assign(shade(shaded.rgb));
        // `.call(this, ...)`, NOT `(super.setupOutput as any)(...)`. Casting a `super`
        // member to a value and invoking it drops the receiver, so `this` is undefined
        // inside the base method and its `this.premultipliedAlpha` check throws.
        return (super.setupOutput as NodeArg).call(this, builder, shaded);
      }
    } as unknown as T;
    cache.set(Base, Shaded as NodeMaterialClass);
    return Shaded;
  };

  return {
    fog,
    shade,
    litClass,
  };
}
