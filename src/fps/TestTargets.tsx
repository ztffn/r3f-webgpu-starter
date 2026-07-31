// Human-scale figures dropped into the terrain as a CONTRAST REFERENCE for grass.
//
// Grass cannot be judged against itself. The DF2 screenshots that define the target
// look all contain a soldier — that is what makes strand thickness, canopy height and
// concealment readable at a glance (docs/07 §1.5). This places a range ladder of
// figures so the same comparison is available here. It is debug-only under
// `?targets=1`, and becomes resettable gameplay targets under `?scene=scope`.

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Heightfield } from "../df2/Heightfield";
import { HealthDamageable } from "./combat/Damageable";
import type { ThreeWorldQuery } from "./core/WorldQuery";

/**
 * Third-party models, loaded from the untracked `testmodels/` directory by the same
 * `new URL(..., import.meta.url)` route `WeaponPrototype` already uses for its rig.
 *
 * These are commercial game assets and are NOT this project's to redistribute — unlike
 * the DF2 mod data, which the mod team authored and released as freeware (docs/01 §3).
 * They stay out of version control, and this whole component stays behind a debug flag
 * so a production build has no reason to pull them in.
 */
const MODELS = [
  new URL("../../testmodels/captain_price.glb", import.meta.url).href,
  new URL("../../testmodels/mgs4_military.glb", import.meta.url).href,
  new URL("../../testmodels/target_shooting_training.glb", import.meta.url).href,
];

/**
 * A range ladder, metres from the origin, matching the sweep docs/07 §8 uses for
 * concealment: close enough to read strand detail against, far enough to show where a
 * standing figure stops being separable from the canopy.
 */
const PLACEMENTS: Array<{ range: number; bearing: number; model: number }> = [
  { range: 8, bearing: -0.18, model: 0 },
  { range: 18, bearing: 0.16, model: 1 },
  { range: 35, bearing: -0.1, model: 2 },
  { range: 70, bearing: 0.12, model: 0 },
  { range: 140, bearing: -0.06, model: 1 },
];

/** Metres tall each figure is normalised to, so mismatched export scales cannot lie. */
const FIGURE_HEIGHT = 1.8;

export interface TestTargetsProps {
  heightfield: Heightfield;
  /**
   * World x and z the ladder is laid out from — the viewing position, not the first
   * figure. Two scalars, NOT a tuple: a tuple prop is a fresh array on every parent
   * render, so it changes effect identity every frame and the whole ladder is disposed
   * and refetched continuously — which looks exactly like the models never loading.
   */
  originX: number;
  originZ: number;
  /**
   * Direction the ladder runs, radians, in the camera's own yaw convention:
   * forward is `(sin(yaw), _, cos(yaw))` — see `FlyControls`. Figures face back down it.
   *
   * Defaults to the bench camera's default yaw of PI, i.e. looking down -Z. Getting this
   * wrong is silent and looks exactly like the models failing to load: at heading 0 the
   * whole ladder is placed directly BEHIND the default view and nothing appears.
   */
  heading?: number;
  /** Optional gameplay query registry; rendering remains useful without one. */
  worldQuery?: Pick<ThreeWorldQuery, "register">;
}

interface TargetRuntime {
  readonly root: THREE.Object3D;
  readonly helper: THREE.Box3Helper;
  readonly damageable: HealthDamageable;
  unregister?: () => void;
  flashTimer?: ReturnType<typeof setTimeout>;
  hideTimer?: ReturnType<typeof setTimeout>;
  resetTimer?: ReturnType<typeof setTimeout>;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

export function TestTargets({
  heightfield,
  originX,
  originZ,
  heading = Math.PI,
  worldQuery,
}: TestTargetsProps) {
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.name = "test-targets";
    return g;
  }, []);
  const loaded = useRef<THREE.Object3D[]>([]);
  const targetRuntimes = useRef<TargetRuntime[]>([]);

  useEffect(() => {
    let alive = true;
    const loader = new GLTFLoader();

    const registerRuntime = (runtime: TargetRuntime) => {
      if (!runtime.unregister && worldQuery) {
        runtime.unregister = worldQuery.register({
          root: runtime.root,
          kind: "target",
          damageable: runtime.damageable,
        });
      }
    };

    const armTarget = (root: THREE.Object3D, id: string) => {
      const helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(root), 0xff3b1f);
      helper.visible = false;
      group.add(helper);

      let runtime!: TargetRuntime;
      const damageable = new HealthDamageable(id, 100, (result, info) => {
        if (!info) {
          root.visible = true;
          helper.visible = false;
          registerRuntime(runtime);
          return;
        }

        helper.visible = true;
        if (runtime.flashTimer) clearTimeout(runtime.flashTimer);
        runtime.flashTimer = setTimeout(() => {
          helper.visible = false;
        }, 160);

        if (result.destroyed) {
          runtime.unregister?.();
          runtime.unregister = undefined;
          if (runtime.resetTimer) clearTimeout(runtime.resetTimer);
          runtime.resetTimer = setTimeout(() => damageable.reset(), 1_200);
          runtime.hideTimer = setTimeout(() => {
            if (damageable.health === 0) root.visible = false;
          }, 170);
        }
      });
      runtime = { root, helper, damageable };
      targetRuntimes.current.push(runtime);
      registerRuntime(runtime);
    };

    // A plain 1.8 m box 4 m ahead, needing NO asset. It separates three failure modes
    // that all look identical from the camera — "no targets":
    //   marker absent  -> the component never mounted, or the ladder is behind you
    //   marker present, figures absent -> the GLBs are not loading
    //   both present   -> placement or scale is wrong
    // Kept permanently: it costs one box and it is the only cheap way to tell those
    // apart from inside the game rather than from the console.
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, FIGURE_HEIGHT, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff00ff })
    );
    const mx = originX + Math.sin(heading) * 4;
    const mz = originZ + Math.cos(heading) * 4;
    marker.position.set(mx, heightfield.sample(mx, mz) + FIGURE_HEIGHT / 2, mz);
    group.add(marker);
    loaded.current.push(marker);
    armTarget(marker, "range-marker");
    console.log(
      `[df2] targets: origin ${originX},${originZ} heading ${heading.toFixed(2)}; ` +
        `marker at ${mx.toFixed(1)},${marker.position.y.toFixed(1)},${mz.toFixed(1)}`
    );

    const place = (index: number, source: THREE.Object3D) => {
      const p = PLACEMENTS[index];
      const figure = source.clone(true);

      // Normalise to human height from the model's own bounds. The three GLBs come from
      // different sources with different export scales, so trusting any single scalar
      // would silently make one of them the wrong size — and wrong size is exactly the
      // error this component exists to expose in the grass.
      const box = new THREE.Box3().setFromObject(figure);
      const size = new THREE.Vector3();
      box.getSize(size);
      if (size.y > 0.0001) figure.scale.setScalar(FIGURE_HEIGHT / size.y);

      // Re-measure after scaling and sit the feet on the terrain rather than the origin,
      // so a figure on a slope is not half-buried or floating.
      const scaled = new THREE.Box3().setFromObject(figure);
      const x = originX + Math.sin(heading + p.bearing) * p.range;
      const z = originZ + Math.cos(heading + p.bearing) * p.range;
      figure.position.set(x, heightfield.sample(x, z) - scaled.min.y, z);
      // Face back down the ladder, so every figure is seen front-on from the origin.
      figure.rotation.y = heading + p.bearing + Math.PI;

      group.add(figure);
      loaded.current.push(figure);
      armTarget(figure, `range-target-${index + 1}`);
      console.log(
        `[df2] target ${index}: raw height ${size.y.toFixed(3)}m -> scale ` +
          `${figure.scale.x.toFixed(3)} at ${x.toFixed(1)},${figure.position.y.toFixed(1)},${z.toFixed(1)}`
      );
    };

    // ONE load per distinct model, then clone per placement. Dispatching per placement
    // and de-duplicating on a cache does not work: the ladder reuses models, the loads
    // are async, and every dispatch sees an empty cache — so each model would be fetched
    // and its placements filled twice over. Group first, fetch once.
    const byModel = new Map<number, number[]>();
    PLACEMENTS.forEach((p, index) => {
      const list = byModel.get(p.model);
      if (list) list.push(index);
      else byModel.set(p.model, [index]);
    });

    for (const [model, indices] of byModel) {
      loader.load(
        MODELS[model],
        (gltf) => {
          if (!alive) {
            disposeObject(gltf.scene);
            return;
          }
          for (const index of indices) place(index, gltf.scene);
          console.log(`[df2] targets: loaded ${MODELS[model]} -> ${indices.length} placed`);
        },
        undefined,
        (err) => console.warn(`[df2] test target ${MODELS[model]} failed to load`, err)
      );
    }

    const resetTargets = (event: KeyboardEvent) => {
      if (event.code !== "KeyT" || event.repeat) return;
      for (const runtime of targetRuntimes.current) runtime.damageable.reset();
    };
    addEventListener("keydown", resetTargets);

    return () => {
      alive = false;
      removeEventListener("keydown", resetTargets);
      for (const runtime of targetRuntimes.current) {
        runtime.unregister?.();
        if (runtime.flashTimer) clearTimeout(runtime.flashTimer);
        if (runtime.hideTimer) clearTimeout(runtime.hideTimer);
        if (runtime.resetTimer) clearTimeout(runtime.resetTimer);
        group.remove(runtime.helper);
        runtime.helper.geometry.dispose();
        const helperMaterial = runtime.helper.material;
        if (Array.isArray(helperMaterial)) helperMaterial.forEach((material) => material.dispose());
        else helperMaterial.dispose();
      }
      targetRuntimes.current = [];
      // Detach only. `clone(true)` SHARES geometry and materials with the loaded source,
      // so disposing a clone frees buffers the other clones — and any later clone of the
      // same source — are still using, leaving invisible or corrupt meshes behind.
      // The marker owns its own geometry, so that one is disposed.
      for (const figure of loaded.current) group.remove(figure);
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
      loaded.current = [];
    };
  }, [group, heightfield, originX, originZ, heading, worldQuery]);

  return <primitive object={group} />;
}
