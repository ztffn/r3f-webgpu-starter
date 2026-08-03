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

/** Unit capsule the per-stance dimensions scale; matches the local proxy. */
const REFERENCE_RADIUS = 0.5;
const REFERENCE_HEIGHT = 2;
/** Wire yaw snaps at the patch rate; smooth it at the position smoother's rate. */
const YAW_RATE = 12;
const REMOTE_COLOR = 0xb8563f;

export interface RemotePlayersProps {
  client: GameClient;
  atmosphere: Atmosphere;
}

interface PooledRemote {
  readonly mesh: THREE.Mesh;
  yawRadians: number;
}

export function RemotePlayers({ client, atmosphere }: RemotePlayersProps) {
  const groupRef = useRef<THREE.Group | null>(null);
  const pool = useMemo(() => new Map<number, PooledRemote>(), []);
  const seen = useMemo(() => new Set<number>(), []);

  const shared = useMemo(() => {
    const geometry = new THREE.CapsuleGeometry(
      REFERENCE_RADIUS,
      REFERENCE_HEIGHT - REFERENCE_RADIUS * 2,
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
    const clamped = Math.min(delta, 0.1);
    client.interpolateRemotes(clamped);
    const blend = 1 - Math.exp(-YAW_RATE * clamped);
    const stances = client.tuning.stances;

    seen.clear();
    for (const remote of client.remotePlayers) {
      seen.add(remote.id);
      let entry = pool.get(remote.id);
      if (entry === undefined) {
        const mesh = new THREE.Mesh(shared.geometry, shared.material);
        group.add(mesh);
        entry = { mesh, yawRadians: remote.yawRadians };
        pool.set(remote.id, entry);
      }
      // The wire now carries the stance blend; use it, or every remote stance
      // change pops instead of ducking the way the local capsule does.
      const from = stances[remote.state.previousStance];
      const to = stances[remote.state.stance];
      const progress = remote.state.stanceProgress;
      const height = from.height + (to.height - from.height) * progress;
      const radius = from.radius + (to.radius - from.radius) * progress;
      entry.yawRadians += shortestArc(remote.yawRadians - entry.yawRadians) * blend;
      entry.mesh.position.set(
        remote.position.x,
        remote.position.y + height / 2,
        remote.position.z
      );
      entry.mesh.rotation.y = entry.yawRadians;
      entry.mesh.scale.set(
        radius / REFERENCE_RADIUS,
        height / REFERENCE_HEIGHT,
        radius / REFERENCE_RADIUS
      );
    }

    for (const [id, entry] of pool) {
      if (seen.has(id)) continue;
      group.remove(entry.mesh);
      pool.delete(id);
    }
  });

  return <group ref={groupRef} />;
}

function shortestArc(deltaRadians: number): number {
  const wrapped = (deltaRadians + Math.PI) % (2 * Math.PI);
  return (wrapped < 0 ? wrapped + 2 * Math.PI : wrapped) - Math.PI;
}
