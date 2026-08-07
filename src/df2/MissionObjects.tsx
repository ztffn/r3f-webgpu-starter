// MissionObjects — render a converted DF2 mission's object layout on the
// terrain: `?mission=warfields` reads /assets/local/missions/<slug>/mission.json
// (gitignored — retail-derived) and seats every placement on the heightfield.
//
// Placements only. A mission also carries sky, fog, water and weather; those are
// deliberately not imported (see tools/df2-extract/mission.mjs) — this project
// has its own measured presets and the room owns a session's visuals.
//
// One GLB is fetched per MODEL and cloned per placement, so 365 objects cost 40
// downloads; clones share geometry and material with the original.

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Heightfield } from "./Heightfield";
import { isAssetSlug, readMapSlug } from "./config";
import { disposeSubtree } from "./DevPlacedObject";

interface Placement {
  model: string;
  name: string;
  kind: string;
  /** Metres, mission space. */
  x: number;
  y: number;
  /** Metres above the sampled terrain surface. */
  zOffset: number;
  /** Compass bearing, degrees. */
  facing: number;
  /** Second angle (tilt), degrees — how the mission tilts its wreckage. */
  pitch: number;
  /** Ground vehicle: sit on the slope rather than plumb (see mission.mjs). */
  conform?: boolean;
}

interface MissionFile {
  name: string;
  designer: string;
  terrain: string;
  placements: Placement[];
  models: string[];
}

/**
 * How mission (x, y) maps onto world (X, Z).
 *
 * `x,y` — MEASURED, and it contradicts opennova (whose `GetWorldPosition()`
 * implies `x,-y`; that reference targets Joint Operations, two generations on).
 *
 * The test: "KillRing" is described by its author as a swamp arena, and DFG4's
 * water sits at raw elevation 11. Sampling the terrain inside the ring, `x,y`
 * puts the arena **98% below the water line** while `x,-y` gives 74% — against
 * a map-wide baseline of 72%, i.e. indistinguishable from anywhere else. The
 * arena was dug into a swamp; only one mapping reproduces that.
 */
const AXES: Record<string, (x: number, y: number) => [number, number]> = {
  xy: (x, y) => [x, y],
  "x-y": (x, y) => [x, -y],
  "-xy": (x, y) => [-x, y],
  "-x-y": (x, y) => [-x, -y],
  yx: (x, y) => [y, x],
  "y-x": (x, y) => [y, -x],
  "-yx": (x, y) => [-y, x],
  "-y-x": (x, y) => [-y, -x],
};

/**
 * World yaw = DEFAULT_YAW_OFFSET_DEG + facing, i.e. **facing - 90°**.
 *
 * MEASURED against a map built for the purpose rather than taken from a
 * reference: "KillRing" (Varg, 2001) rings its arena with 195 wall segments,
 * and a wall on a circle must be TANGENT, which is a constraint per segment.
 * Across all 195, `facing + theta = 90° (mod 180)` where theta is the segment's
 * angular position — that pins the yaw to within the 180° a symmetric wall
 * panel cannot resolve, and rules out the 180 that opennova's Joint Operations
 * code implies.
 *
 * The remaining 180° comes from two asymmetric props in the same map, which
 * agree: the four 50-cal emplacements around the central tower face OUTWARD,
 * and the four ladders present their climbing side AWAY from it (both models
 * carry their geometry offset along +X, the forward axis — the 50-cal by
 * 0.74 m, which is its barrel). `?misyaw=` overrides.
 */
const DEFAULT_YAW_OFFSET_DEG = -90;

/** World up, for the slope-conforming path. */
const UP = new THREE.Vector3(0, 1, 0);

export function MissionObjects({ heightfield }: { heightfield: Heightfield }) {
  const { slug, axis, yawOffset, facingSign, applyPitch, applyConform } = useMemo(() => {
    const p = new URLSearchParams(
      typeof window === "undefined" ? "" : window.location.search
    );
    const s = p.get("mission");
    // A bare `?misyaw` flag reads as "" and Number("") is 0 — that must fall
    // through to the measured default rather than silently zero the -90° offset.
    const rawYaw = p.get("misyaw");
    const yaw = rawYaw === null || rawYaw.trim() === "" ? Number.NaN : Number(rawYaw);
    // Object.hasOwn, not `in`: `in` walks the prototype chain, so
    // `?misaxis=constructor` passed the whitelist and the placement effect then
    // destructured Object.prototype's constructor as an axis mapping — a crash
    // (or NaN positions) from a URL parameter.
    const requestedAxis = p.get("misaxis") ?? "xy";
    return {
      slug: s && isAssetSlug(s) ? s : null,
      axis: Object.hasOwn(AXES, requestedAxis) ? requestedAxis : "xy",
      yawOffset: Number.isFinite(yaw) ? yaw : DEFAULT_YAW_OFFSET_DEG,
      // Bearings add to the yaw (measured — see DEFAULT_YAW_OFFSET_DEG);
      // `?miscw=1` negates the term for the opposite sense.
      facingSign: p.get("miscw") === "1" ? -1 : 1,
      // Pitch defaults ON: the reference implementation carries a per-entity
      // pitch and roll alongside yaw, and every one of Warfields' 37 tilted
      // items is wreckage or toppled masonry (the three husks, 33 stone
      // columns, a shell) — authored tilt, not noise.
      applyPitch: p.get("mispitch") !== "0",
      // Slope-conforming defaults OFF. `axle_dist` marks exactly the 30 ground
      // vehicles (30/30, no helicopter or husk has it), which says the engine
      // tracked ground contact for things that DRIVE — but the reference
      // implementation places every entity from its stored rotation alone and
      // never consults the terrain, so a statically placed vehicle stands as
      // authored. `?misconform=1` tilts vehicles onto the surface normal.
      applyConform: p.get("misconform") === "1",
    };
  }, []);

  const group = useMemo(() => {
    const g = new THREE.Group();
    g.name = "mission-objects";
    return g;
  }, []);

  const [loaded, setLoaded] = useState<{
    mission: MissionFile;
    scenes: Map<string, THREE.Object3D>;
  } | null>(null);

  // Fetch manifest + one GLB per distinct model. Keyed on the slug alone: the
  // world rebuilds whenever a scale dial commits, and re-downloading 40 models
  // to move objects that are already in memory is the wrong shape of work.
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    const loader = new GLTFLoader();
    const base = `/assets/local/missions/${slug}`;
    let acquired: THREE.Object3D[] = [];

    (async () => {
      const res = await fetch(`${base}/mission.json`);
      if (!res.ok) throw new Error(`mission.json: HTTP ${res.status}`);
      const mission: MissionFile = await res.json();
      const entries = await Promise.all(
        mission.models.map(async (m) => {
          try {
            const gltf = await loader.loadAsync(`${base}/models/${m}.glb`);
            return [m, gltf.scene] as const;
          } catch (err) {
            console.warn(`[MissionObjects] ${m}:`, err);
            return null;
          }
        })
      );
      const scenes = new Map(entries.filter((e): e is [string, THREE.Group] => e !== null));
      acquired = [...scenes.values()];
      if (!alive) {
        acquired.forEach(disposeSubtree);
        return;
      }
      // A mission is authored for ONE terrain; seated on any other heightfield
      // every wall is half-buried or floating while placement itself works
      // perfectly — the same "otherwise undiagnosable" class as the ?map=/server
      // mismatch in DF2Scene, so it gets the same loud console line.
      const mapSlug = readMapSlug(typeof window === "undefined" ? "" : window.location.search);
      if (mission.terrain && mission.terrain.toLowerCase() !== mapSlug) {
        console.warn(
          `[MissionObjects] "${mission.name}" was authored for terrain ` +
            `"${mission.terrain}" but the loaded map is "${mapSlug}" — every ` +
            `placement will seat on the wrong ground. Try ?map=${mission.terrain.toLowerCase()}.`
        );
      }
      console.log(
        `[MissionObjects] "${mission.name}" by ${mission.designer} — ` +
          `${mission.placements.length} objects, ${scenes.size}/${mission.models.length} models`
      );
      setLoaded({ mission, scenes });
    })().catch((err) => console.warn("[MissionObjects] load failed:", err));

    return () => {
      alive = false;
      setLoaded(null);
      acquired.forEach(disposeSubtree);
    };
  }, [slug]);

  // Place, and re-place after a world rebuild. Clones are cheap (shared
  // geometry); the terrain sample is what has to be redone when scale changes.
  useEffect(() => {
    if (!loaded) return;
    const map = AXES[axis]!;
    // Scratch, reused across every placement rather than per object.
    const normal: [number, number, number] = [0, 1, 0];
    const up = new THREE.Vector3();
    const spin = new THREE.Quaternion();
    const euler = new THREE.Euler();
    for (const p of loaded.mission.placements) {
      const source = loaded.scenes.get(p.model);
      if (!source) continue;
      const [wx, wz] = map(p.x, p.y);
      const clone = source.clone(true);
      clone.position.set(wx, heightfield.sample(wx, wz) + p.zOffset, wz);
      const yaw = THREE.MathUtils.degToRad(yawOffset + facingSign * p.facing);
      // YXZ, with pitch NEGATED about X — the order and signs the reference
      // implementation uses (`FromEuler(-pitch, 180-yaw, +roll)`). Pitch about
      // Z, which an earlier pass used, rolls wreckage sideways instead of
      // tipping it nose-down.
      euler.set(applyPitch ? THREE.MathUtils.degToRad(-p.pitch) : 0, yaw, 0, "YXZ");
      clone.quaternion.setFromEuler(euler);
      if (applyConform && p.conform) {
        // Stand the vehicle on the slope: tilt +Y onto the surface normal, then
        // spin it to its heading within that tilted frame.
        heightfield.normal(wx, wz, normal);
        up.set(normal[0], normal[1], normal[2]);
        clone.quaternion
          .setFromUnitVectors(UP, up)
          .multiply(spin.setFromAxisAngle(UP, yaw));
      }
      group.add(clone);
    }
    return () => {
      group.clear();
    };
  }, [group, heightfield, loaded, axis, yawOffset, facingSign, applyPitch, applyConform]);

  if (!slug) return null;
  return <primitive object={group} />;
}
