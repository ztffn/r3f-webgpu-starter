import type { WeaponDefinition, WeaponSlotId } from "../../combat/WeaponDefinition.ts";
import { LoadoutSystem, type LoadoutSlot } from "./LoadoutSystem.ts";
import { deriveWeaponInstanceSeed, WeaponSystem } from "./WeaponSystem.ts";
import {
  GLOCK_DEFINITION,
  M4_DEFINITION,
  SAW_DEFINITION,
  SNIPER_DEFINITION,
} from "../../combat/weaponDefinitions.ts";

/** One stable identity for the single local player of the prototype scene. */
export const LOCAL_PLAYER_SEED = 1;

/**
 * The authored slot table, exported so the respawn screen can SHOW the kit a
 * player will actually carry instead of restating it. One list, two readers:
 * a restated copy is how a screen ends up promising a rifle the loadout
 * no longer contains.
 */
export function developmentKit(
  sniperDefinition: WeaponDefinition = SNIPER_DEFINITION
): ReadonlyArray<{ inputSlot: number; id: WeaponSlotId; definition: WeaponDefinition }> {
  return [
    { inputSlot: 1, id: "primary", definition: sniperDefinition },
    { inputSlot: 2, id: "secondary", definition: M4_DEFINITION },
    { inputSlot: 3, id: "sidearm", definition: GLOCK_DEFINITION },
    { inputSlot: 4, id: "support", definition: SAW_DEFINITION },
  ];
}

/**
 * Keyboard-accessible development loadout. Keeping this mapping on the
 * gameplay side prevents the proxy GLTF from becoming equipment truth.
 *
 * `shooterSeed` is the loadout's stable identity. Replaying it reproduces every
 * weapon's pattern exactly, while two shooters given different seeds never
 * share one, even when they carry the same definitions.
 */
export function createDevelopmentLoadout(
  shooterSeed: number = LOCAL_PLAYER_SEED,
  sniperDefinition: WeaponDefinition = SNIPER_DEFINITION
): LoadoutSystem {
  const authored = developmentKit(sniperDefinition);
  const slots: LoadoutSlot[] = authored.map(({ inputSlot, id, definition }) => ({
    inputSlot,
    id,
    weapon: new WeaponSystem(
      definition,
      deriveWeaponInstanceSeed(shooterSeed, id, definition.id)
    ),
  }));
  return new LoadoutSystem(slots, "primary");
}
