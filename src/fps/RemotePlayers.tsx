// Remote players, interpolated from authoritative snapshots.
//
// Owns the single per-frame interpolateRemotes call and syncs a pooled set of
// stance-scaled capsules to GameClient.remotePlayers imperatively — that map
// mutates without React knowing, so remotes are never mapped to JSX. The
// capsule is unlit and runs through atmosphere.shade: remote players are scene
// content, not a diagnostic overlay, so unlike the local collider proxy they
// must sit in the same weather as the terrain (docs/08 §8 invariant 7).

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { color } from "three/tsl";
import type { GameClient } from "../net/GameClient.ts";
import type { Atmosphere } from "../df2/atmosphere";
import { blendedStanceDimension } from "../motor/MotorTypes.ts";
import { PROXY_HEIGHT, PROXY_RADIUS } from "./MotorControls";

const REMOTE_COLOR = 0xb8563f;

export interface RemotePlayersProps {
  client: GameClient;
  atmosphere: Atmosphere;
}

export function RemotePlayers({ client, atmosphere }: RemotePlayersProps) {
  const groupRef = useRef<THREE.Group | null>(null);
  const pool = useMemo(() => new Map<number, THREE.Mesh>(), []);
  const seen = useMemo(() => new Set<number>(), []);

  // The same unit capsule the local collider proxy scales, so the two cannot
  // drift apart in reference dimensions; only the material differs.
  const shared = useMemo(() => {
    const geometry = new THREE.CapsuleGeometry(
      PROXY_RADIUS,
      PROXY_HEIGHT - PROXY_RADIUS * 2,
      6,
      16
    );
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = atmosphere.shade(color(REMOTE_COLOR));
    return { geometry, material };
  }, [atmosphere]);

  useEffect(
    () => () => {
      pool.clear();
      shared.geometry.dispose();
      shared.material.dispose();
    },
    [pool, shared]
  );

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (group === null) return;
    client.interpolateRemotes(Math.min(delta, 0.1));

    seen.clear();
    for (const remote of client.remotePlayers) {
      seen.add(remote.id);
      let mesh = pool.get(remote.id);
      if (mesh === undefined) {
        mesh = new THREE.Mesh(shared.geometry, shared.material);
        group.add(mesh);
        pool.set(remote.id, mesh);
      }
      // The wire carries the stance blend; use it, or every remote stance
      // change pops instead of ducking the way the local capsule does.
      const height = blendedStanceDimension(remote.state, client.tuning, "height");
      const radius = blendedStanceDimension(remote.state, client.tuning, "radius");
      mesh.position.set(
        remote.position.x,
        remote.position.y + height / 2,
        remote.position.z
      );
      mesh.rotation.y = remote.yawRadians;
      mesh.scale.set(
        radius / PROXY_RADIUS,
        height / PROXY_HEIGHT,
        radius / PROXY_RADIUS
      );
    }

    // The pool is always a superset of `seen`, so equal sizes proves there is
    // nothing to remove — the sweep only runs on the frame someone leaves.
    if (pool.size !== seen.size) {
      pool.forEach((mesh, id) => {
        if (seen.has(id)) return;
        group.remove(mesh);
        pool.delete(id);
      });
    }
  });

  return <group ref={groupRef} />;
}
