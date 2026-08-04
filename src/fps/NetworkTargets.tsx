// The room's server-owned targets, rendered from replicated state.
//
// The server places them, scores them, and respawns them (docs/12 §8.3); this
// component only draws what the WorldTargets packet says and registers local
// presentation colliders so YOUR OWN rounds still kick dust off them. Local
// hits apply NO damage — health moves when the server says it moved.

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { color, mix, uniform } from "three/tsl";
import type { GameClient } from "../net/GameClient.ts";
import type { WorldTargetState } from "../net/SnapshotCodec.ts";
import type { Damageable } from "../combat/Damageable.ts";
import type { Atmosphere } from "../df2/atmosphere";
import type { RegisteredWorldQuery, WorldQueryRegistrationHandle } from "./core/WorldQuery";

const TARGET_COLOR = 0xc9a86a;
const HIT_FLASH_COLOR = 0xff5030;
const FLASH_DECAY_PER_SECOND = 7;
/** A destroyed target keels over instead of vanishing: honest, and visibly down. */
const FALLEN_TILT_RADIANS = 1.45;

interface TargetVisual {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicNodeMaterial;
  /** The TSL uniform driving the hit flash; only `.value` is touched here. */
  readonly flash: { value: number };
  readonly damageable: Damageable;
  state: WorldTargetState;
  unregister: WorldQueryRegistrationHandle | null;
}

export interface NetworkTargetsProps {
  client: GameClient;
  worldQuery: Pick<RegisteredWorldQuery, "register">;
  atmosphere: Atmosphere;
}

export function NetworkTargets({ client, worldQuery, atmosphere }: NetworkTargetsProps) {
  const targets = useSyncExternalStore(client.subscribeWorldTargets, client.getWorldTargets);
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.name = "network-targets";
    return g;
  }, []);
  const pool = useRef(new Map<number, TargetVisual>());

  useEffect(() => {
    const visuals = pool.current;
    if (targets === null) return;
    const present = new Set<number>();

    for (const state of targets) {
      present.add(state.id);
      let visual = visuals.get(state.id);
      if (visual === undefined) {
        const flash = uniform(0);
        const material = new THREE.MeshBasicNodeMaterial();
        // Same fog rule as every scene mesh: an unshaded target would glow
        // through the very concealment the room's weather is enforcing.
        material.colorNode = atmosphere.shade(
          mix(color(TARGET_COLOR), color(HIT_FLASH_COLOR), flash)
        );
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(state.radiusMetres * 2, state.heightMetres, 0.12),
          material
        );
        mesh.name = `network-target-${state.id}`;
        group.add(mesh);

        // Presentation-only damageable: local rounds flash it and kick dust,
        // but applied damage is ZERO — the server owns the health.
        const visualRef: { current: TargetVisual | null } = { current: null };
        const damageable: Damageable = {
          id: `network-target-${state.id}`,
          get maxHealth() {
            return visualRef.current?.state.maxHealth ?? 0;
          },
          get health() {
            return visualRef.current?.state.health ?? 0;
          },
          applyDamage() {
            if (visualRef.current) visualRef.current.flash.value = 1;
            const health = visualRef.current?.state.health ?? 0;
            return { applied: 0, health, destroyed: false };
          },
          reset() {},
        };
        visual = { mesh, material, flash, damageable, state, unregister: null };
        visualRef.current = visual;
        visuals.set(state.id, visual);
      }

      visual.state = state;
      visual.mesh.position.set(state.x, state.y + state.heightMetres / 2, state.z);
      const standing = state.health > 0;
      visual.mesh.rotation.x = standing ? 0 : FALLEN_TILT_RADIANS;
      if (standing && visual.unregister === null) {
        visual.unregister = worldQuery.register({
          root: visual.mesh,
          kind: "target",
          objectId: `network-target-${state.id}`,
          damageable: visual.damageable,
        });
      } else if (!standing && visual.unregister !== null) {
        // A fallen target is not cover and not a bullet sponge.
        visual.unregister();
        visual.unregister = null;
      } else if (standing) {
        visual.unregister?.refresh();
      }
    }

    for (const [id, visual] of visuals) {
      if (present.has(id)) continue;
      visual.unregister?.();
      group.remove(visual.mesh);
      visual.mesh.geometry.dispose();
      visual.material.dispose();
      visuals.delete(id);
    }
  }, [targets, group, worldQuery, atmosphere]);

  // Decay hit flashes per rendered frame, on the same loop everything else uses.
  useFrame((_, delta) => {
    const dt = Math.min(0.1, Math.max(0, delta));
    for (const visual of pool.current.values()) {
      if (visual.flash.value > 0) {
        visual.flash.value = Math.max(0, visual.flash.value - dt * FLASH_DECAY_PER_SECOND);
      }
    }
  });

  useEffect(
    () => () => {
      for (const visual of pool.current.values()) {
        visual.unregister?.();
        visual.mesh.geometry.dispose();
        visual.material.dispose();
      }
      pool.current.clear();
    },
    []
  );

  return <primitive object={group} />;
}
