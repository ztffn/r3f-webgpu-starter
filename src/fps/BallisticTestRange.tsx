import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import type { Heightfield } from "../df2/Heightfield";
import type { RegisteredWorldQuery } from "./core/WorldQuery";
import {
  createWorldObjectInstance,
  type WorldObjectDefinition,
  type WorldObjectInstance,
} from "./world/WorldObjectPrefab";

const COVER_RANGE_METRES = 26;
const TARGET_RANGE_METRES = 31;
const HEADING = Math.PI;

const COVER: readonly Omit<WorldObjectDefinition, "id">[] = [
  {
    kind: "world",
    surfaceId: "cloth",
    collider: { width: 2.2, height: 2.2, depth: 0.012, penetrationThicknessMetres: 0.012 },
    visual: { color: 0x82795d, roughness: 1 },
  },
  {
    kind: "world",
    surfaceId: "wood",
    collider: { width: 2.2, height: 2.2, depth: 0.06, penetrationThicknessMetres: 0.06 },
    visual: { color: 0x80512f, roughness: 0.92 },
  },
  {
    kind: "world",
    surfaceId: "sheet-metal",
    collider: { width: 2.2, height: 2.2, depth: 0.03, penetrationThicknessMetres: 0.003 },
    visual: { color: 0x78848a, roughness: 0.42, metalness: 0.82 },
  },
  {
    kind: "world",
    surfaceId: "armored-metal",
    collider: { width: 2.2, height: 2.2, depth: 0.12, penetrationThicknessMetres: 0.012 },
    visual: { color: 0x303b3e, roughness: 0.34, metalness: 0.9 },
  },
  {
    kind: "world",
    surfaceId: "glass",
    collider: { width: 2.2, height: 2.2, depth: 0.025, penetrationThicknessMetres: 0.008 },
    visual: { color: 0xaee9f2, opacity: 0.46, roughness: 0.12 },
  },
  {
    kind: "world",
    surfaceId: "stone",
    collider: { width: 2.2, height: 2.2, depth: 0.2, penetrationThicknessMetres: 0.2 },
    visual: { color: 0x77756e, roughness: 1 },
  },
  {
    kind: "world",
    surfaceId: "dirt",
    collider: { width: 2.2, height: 2.2, depth: 0.4, penetrationThicknessMetres: 0.4 },
    visual: { color: 0x6f5136, roughness: 1 },
  },
  {
    kind: "world",
    surfaceId: "water",
    collider: { width: 2.2, height: 2.2, depth: 0.5, penetrationThicknessMetres: 0.5 },
    visual: { color: 0x4eacc7, opacity: 0.5, roughness: 0.08 },
  },
];

export interface BallisticTestRangeProps {
  readonly heightfield: Heightfield;
  readonly worldQuery: RegisteredWorldQuery;
  readonly originX?: number;
  readonly originZ?: number;
}

function place(
  instance: WorldObjectInstance,
  heightfield: Heightfield,
  x: number,
  z: number
): void {
  instance.root.position.set(
    x,
    heightfield.sample(x, z) + instance.definition.collider.height * 0.5,
    z
  );
  instance.root.rotation.y = HEADING;
}

/** Procedural, asset-free penetration lanes mounted only by `?impacttest=1`. */
export function BallisticTestRange({
  heightfield,
  worldQuery,
  originX = 0,
  originZ = 320,
}: BallisticTestRangeProps) {
  const runtime = useMemo(() => {
    const group = new THREE.Group();
    group.name = "ballistic-material-test-range";
    const instances: WorldObjectInstance[] = [];
    const laneSpacing = 2.75;
    const firstX = originX - ((COVER.length - 1) * laneSpacing) / 2;
    for (let lane = 0; lane < COVER.length; lane += 1) {
      const x = firstX + lane * laneSpacing;
      const coverZ = originZ + Math.cos(HEADING) * COVER_RANGE_METRES;
      const targetZ = originZ + Math.cos(HEADING) * TARGET_RANGE_METRES;
      const cover = createWorldObjectInstance({ ...COVER[lane], id: `cover-${COVER[lane].surfaceId}` });
      const target = createWorldObjectInstance({
        id: `target-behind-${COVER[lane].surfaceId}`,
        kind: "target",
        surfaceId: "flesh",
        collider: { width: 1.4, height: 1.8, depth: 0.24, penetrationThicknessMetres: 0.24 },
        visual: { color: 0x8d3436, roughness: 0.88 },
        destructible: { maxHealth: 100, huskColor: 0x342222 },
      });
      place(cover, heightfield, x, coverZ);
      place(target, heightfield, x, targetZ);
      group.add(cover.root, target.root);
      instances.push(cover, target);
    }
    return { group, instances };
  }, [heightfield, originX, originZ]);

  useEffect(() => {
    const unregister = runtime.instances.map((instance) => instance.register(worldQuery));
    const reset = (event: KeyboardEvent) => {
      if (event.code !== "KeyT" || event.repeat) return;
      for (const instance of runtime.instances) instance.damageable?.reset();
    };
    addEventListener("keydown", reset);
    return () => {
      removeEventListener("keydown", reset);
      for (const disposeRegistration of unregister) disposeRegistration();
    };
  }, [runtime, worldQuery]);

  useEffect(
    () => () => {
      for (const instance of runtime.instances) instance.dispose();
    },
    [runtime]
  );

  return <primitive object={runtime.group} />;
}
