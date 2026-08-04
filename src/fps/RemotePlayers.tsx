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
import {
  CharacterView,
  createCharacterPose,
  fillCharacterPose,
} from "./presentation/CharacterView.ts";
import { loadSoldier, type SoldierAsset } from "./presentation/soldierAssets.ts";
import { chooseDeathClip, type DeathDirection } from "../character/characterClips.ts";
import type { PlayerStance } from "../motor/MotorTypes.ts";

/**
 * The fall used when a body is down but its death packet never arrived.
 *
 * Health says who is dead and the packet only says how they fell, so this is the
 * cost of a dropped packet: a plausible fall facing the wrong way, rather than a
 * corpse standing upright.
 */
const DEFAULT_DEATH_DIRECTION: DeathDirection = "front";

/** What a death packet said about how a body fell. */
interface DeathFacing {
  readonly direction: DeathDirection;
  readonly headshot: boolean;
}

/** Frame-loop scratch for clip selection; the loop allocates nothing. */
const deathSample: {
  direction: DeathDirection;
  headshot: boolean;
  stance: PlayerStance;
} = { direction: "front", headshot: false, stance: "stand" };

const REMOTE_COLOR = 0xb8563f;

interface RemoteVisual {
  /** Always exists: the pre-load stand-in AND the honest prone silhouette. */
  readonly mesh: THREE.Mesh;
  view: CharacterView | null;
}

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

  const pose = useRef(createCharacterPose());
  /**
   * How each dead player was shot, by id.
   *
   * Held here rather than read from the event log every frame because the log is
   * bounded: a body that stays down longer than 64 events would lose the record
   * of how it fell and snap to a different clip. Cleared on respawn.
   */
  const deathFacing = useRef(new Map<number, DeathFacing>());
  /** Last combat event consumed, so the log is read forward and never drained. */
  const lastEventSeq = useRef(0);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (group === null) return;
    const clamped = Math.min(delta, 0.1);
    client.interpolateRemotes(clamped);

    // Read the event log forward for the clip each death should play. Only the
    // CHOICE comes from here; whether a body is down comes from its health.
    for (const event of client.getCombatEvents()) {
      if (event.seq <= lastEventSeq.current) continue;
      lastEventSeq.current = event.seq;
      if (event.kind !== "died") continue;
      // The facing, not the resolved clip: the stance belongs to the remote and
      // is in hand a few lines below, so resolving here would mean looking the
      // player up twice.
      deathFacing.current.set(event.victimId, {
        direction: event.direction,
        headshot: event.headshot,
      });
    }

    seen.clear();
    let promotedThisFrame = false;
    for (const remote of client.remotePlayers) {
      seen.add(remote.id);
      let visual = pool.get(remote.id);
      if (visual === undefined) {
        const mesh = new THREE.Mesh(shared.geometry, shared.material);
        group.add(mesh);
        visual = { mesh, view: null };
        pool.set(remote.id, visual);
      }
      // Promotions are staggered one per frame: N skeleton clones plus N
      // animator builds on the single frame the GLB resolves is a visible
      // hitch, and the capsule already stands in.
      if (visual.view === null && asset !== null && !promotedThisFrame) {
        promotedThisFrame = true;
        visual.view = new CharacterView(asset);
        visual.view.setVisible(false);
        group.add(visual.view.group);
      }

      // Health is the ONLY truth for whether a body is down (docs/12 §8: dead is
      // health zero, not a flag). A dropped death packet costs the right fall,
      // never a corpse that keeps walking.
      const dead = remote.health === 0;
      if (visual.view !== null) {
        const facing = deathFacing.current.get(remote.id);
        // Reused scratch: `die` is idempotent per clip name, so this resolves the
        // same name every frame a body is down and must not allocate to do it.
        deathSample.direction = facing?.direction ?? DEFAULT_DEATH_DIRECTION;
        deathSample.headshot = facing?.headshot ?? false;
        deathSample.stance = remote.state.stance;
        visual.view.setDead(dead, chooseDeathClip(deathSample).name);
      }
      if (!dead) deathFacing.current.delete(remote.id);

      // Prone has no clips in the pack: the character would render a
      // kneel-height crouch over a prone-height collider, betraying exactly
      // the concealment the stance exists for. Until prone clips are baked,
      // a prone remote is the stance-scaled capsule — the honest silhouette.
      //
      // A DEAD prone player is the exception: the fall is the whole point of the
      // feedback, so a body that dies prone shows the character rather than a
      // capsule that simply stops.
      const showCharacter =
        visual.view !== null && (dead || remote.state.stance !== "prone");
      visual.mesh.visible = !showCharacter;
      if (visual.view !== null) visual.view.setVisible(showCharacter);
      if (showCharacter && visual.view !== null) {
        fillCharacterPose(
          pose.current,
          remote.position,
          remote.yawRadians,
          remote.state.pitchRadians,
          remote.state
        );
        visual.view.update(clamped, pose.current);
      } else {
        positionCapsule(visual.mesh, remote, client);
      }
    }

    // The pool is always a superset of `seen`, so equal sizes proves there is
    // nothing to remove — the sweep only runs on the frame someone leaves.
    if (pool.size !== seen.size) {
      pool.forEach((visual, id) => {
        if (seen.has(id)) return;
        visual.view?.dispose();
        group.remove(visual.mesh);
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
