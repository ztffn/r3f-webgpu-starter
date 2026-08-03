// Remote players, interpolated from authoritative snapshots.
//
// Owns the single per-frame interpolateRemotes call and syncs a pooled set of
// visuals to GameClient.remotePlayers imperatively — that map mutates without
// React knowing, so remotes are never mapped to JSX. Each remote is an
// animated CharacterView driven by the same pose facts the local third-person
// view uses (the wire carries pitch and the stance for exactly this); until
// the soldier GLB resolves, a stance-scaled capsule through atmosphere.shade
// stands in, and it stays the permanent fallback if the asset fails to load.

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { color } from "three/tsl";
import type { GameClient, RemotePlayer } from "../net/GameClient.ts";
import type { Atmosphere } from "../df2/atmosphere";
import { blendedStanceDimension } from "../motor/MotorTypes.ts";
import { PROXY_HEIGHT, PROXY_RADIUS } from "./MotorControls";
import { CharacterView, type CharacterPose } from "./presentation/CharacterView.ts";
import { loadSoldier, type SoldierAsset } from "./presentation/soldierAssets.ts";

const REMOTE_COLOR = 0xb8563f;

type RemoteVisual =
  | { readonly kind: "capsule"; readonly mesh: THREE.Mesh }
  | { readonly kind: "character"; readonly view: CharacterView };

export interface RemotePlayersProps {
  client: GameClient;
  atmosphere: Atmosphere;
}

export function RemotePlayers({ client, atmosphere }: RemotePlayersProps) {
  const groupRef = useRef<THREE.Group | null>(null);
  const pool = useMemo(() => new Map<number, RemoteVisual>(), []);
  const seen = useMemo(() => new Set<number>(), []);

  const [asset, setAsset] = useState<SoldierAsset | null>(null);
  useEffect(() => {
    let alive = true;
    loadSoldier().then(
      (loaded) => {
        if (alive) setAsset(loaded);
      },
      (error: unknown) =>
        console.error("soldier GLB failed to load; capsules remain:", error)
    );
    return () => {
      alive = false;
    };
  }, []);

  // The capsule fallback shares the local proxy's reference dimensions so the
  // two cannot drift; only the material differs (scene content, so shaded).
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

  const pose = useRef<CharacterPose>({
    positionX: 0,
    positionY: 0,
    positionZ: 0,
    yawRadians: 0,
    pitchRadians: 0,
    velocityX: 0,
    velocityZ: 0,
    stance: "stand",
    grounded: true,
    sprinting: false,
    aiming: false,
  });

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (group === null) return;
    const clamped = Math.min(delta, 0.1);
    client.interpolateRemotes(clamped);

    seen.clear();
    for (const remote of client.remotePlayers) {
      seen.add(remote.id);
      let visual = pool.get(remote.id);

      // Promote a capsule to the character the moment the asset exists.
      if (asset !== null && (visual === undefined || visual.kind === "capsule")) {
        if (visual !== undefined) group.remove(visual.mesh);
        const view = new CharacterView(asset);
        group.add(view.group);
        visual = { kind: "character", view };
        pool.set(remote.id, visual);
      } else if (visual === undefined) {
        const mesh = new THREE.Mesh(shared.geometry, shared.material);
        group.add(mesh);
        visual = { kind: "capsule", mesh };
        pool.set(remote.id, visual);
      }

      if (visual.kind === "character") {
        const state = pose.current;
        state.positionX = remote.position.x;
        state.positionY = remote.position.y;
        state.positionZ = remote.position.z;
        state.yawRadians = remote.yawRadians;
        state.pitchRadians = remote.state.pitchRadians;
        state.velocityX = remote.state.velocity.x;
        state.velocityZ = remote.state.velocity.z;
        state.stance = remote.state.stance;
        state.grounded = remote.state.grounded;
        state.sprinting = remote.state.sprinting;
        state.aiming = remote.state.aiming;
        visual.view.update(clamped, state);
      } else {
        positionCapsule(visual.mesh, remote, client);
      }
    }

    // The pool is always a superset of `seen`, so equal sizes proves there is
    // nothing to remove — the sweep only runs on the frame someone leaves.
    if (pool.size !== seen.size) {
      pool.forEach((visual, id) => {
        if (seen.has(id)) return;
        if (visual.kind === "character") visual.view.dispose();
        else group.remove(visual.mesh);
        pool.delete(id);
      });
    }
  });

  return <group ref={groupRef} />;
}

function positionCapsule(mesh: THREE.Mesh, remote: RemotePlayer, client: GameClient): void {
  const height = blendedStanceDimension(remote.state, client.tuning, "height");
  const radius = blendedStanceDimension(remote.state, client.tuning, "radius");
  mesh.position.set(remote.position.x, remote.position.y + height / 2, remote.position.z);
  mesh.rotation.y = remote.yawRadians;
  mesh.scale.set(radius / PROXY_RADIUS, height / PROXY_HEIGHT, radius / PROXY_RADIUS);
}
