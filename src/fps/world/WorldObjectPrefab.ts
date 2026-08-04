import * as THREE from "three/webgpu";
import { HealthDamageable } from "../../combat/Damageable.ts";
import type { SurfaceId } from "../../combat/SurfaceProfile.ts";
import type { RegisteredWorldQuery, WorldHitKind } from "../core/WorldQuery";

export interface WorldObjectDefinition {
  readonly id: string;
  readonly kind: WorldHitKind;
  readonly surfaceId: SurfaceId;
  readonly collider: {
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly penetrationThicknessMetres: number;
  };
  readonly visual: {
    readonly color: THREE.ColorRepresentation;
    readonly opacity?: number;
    readonly roughness?: number;
    readonly metalness?: number;
  };
  readonly destructible?: {
    readonly maxHealth: number;
    readonly huskColor: THREE.ColorRepresentation;
  };
}

export interface WorldObjectInstance {
  readonly definition: WorldObjectDefinition;
  readonly root: THREE.Group;
  readonly collider: THREE.Mesh;
  readonly damageable: HealthDamageable | null;
  register(worldQuery: Pick<RegisteredWorldQuery, "register">): () => void;
  dispose(): void;
}

/**
 * Small prefab runtime: authored data, one simplified query collider, optional
 * health, and one intact-to-husk presentation transition. It is intentionally
 * not an ECS and owns no input, weapons, terrain, or impact presentation.
 */
export function createWorldObjectInstance(definition: WorldObjectDefinition): WorldObjectInstance {
  const root = new THREE.Group();
  root.name = definition.id;
  const geometry = new THREE.BoxGeometry(
    definition.collider.width,
    definition.collider.height,
    definition.collider.depth
  );
  const intactMaterial = new THREE.MeshStandardMaterial({
    color: definition.visual.color,
    opacity: definition.visual.opacity ?? 1,
    transparent: (definition.visual.opacity ?? 1) < 1,
    roughness: definition.visual.roughness ?? 0.82,
    metalness: definition.visual.metalness ?? 0,
  });
  const intact = new THREE.Mesh(geometry, intactMaterial);
  intact.name = `${definition.id}-intact`;
  root.add(intact);

  let husk: THREE.Mesh | null = null;
  if (definition.destructible) {
    const huskMaterial = new THREE.MeshStandardMaterial({
      color: definition.destructible.huskColor,
      roughness: 1,
    });
    husk = new THREE.Mesh(geometry, huskMaterial);
    husk.name = `${definition.id}-husk`;
    husk.scale.set(1, 0.22, 1.18);
    husk.position.y = -definition.collider.height * 0.39;
    husk.rotation.z = 0.09;
    husk.visible = false;
    root.add(husk);
  }

  const colliderMaterial = new THREE.MeshBasicMaterial();
  colliderMaterial.visible = false;
  const collider = new THREE.Mesh(geometry, colliderMaterial);
  collider.name = `${definition.id}-collider`;
  root.add(collider);

  const damageable = definition.destructible
    ? new HealthDamageable(definition.id, definition.destructible.maxHealth, (result, info) => {
        const destroyed = info !== null && result.destroyed;
        intact.visible = !destroyed;
        if (husk) husk.visible = destroyed;
        if (info === null) {
          intact.visible = true;
          if (husk) husk.visible = false;
        }
      })
    : null;

  return {
    definition,
    root,
    collider,
    damageable,
    register(worldQuery) {
      root.updateMatrixWorld(true);
      return worldQuery.register({
        root: collider,
        kind: definition.kind,
        objectId: definition.id,
        surfaceId: definition.surfaceId,
        penetrationThicknessMetres: definition.collider.penetrationThicknessMetres,
        damageable: damageable ?? undefined,
      });
    },
    dispose() {
      geometry.dispose();
      intactMaterial.dispose();
      if (husk) (husk.material as THREE.Material).dispose();
      colliderMaterial.dispose();
    },
  };
}
