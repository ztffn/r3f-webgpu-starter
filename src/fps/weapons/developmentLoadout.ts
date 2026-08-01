import type { WeaponDefinition } from "./WeaponDefinition.ts";
import { LoadoutSystem } from "./LoadoutSystem.ts";
import { WeaponSystem } from "./WeaponSystem.ts";
import {
  GLOCK_DEFINITION,
  M4_DEFINITION,
  SAW_DEFINITION,
  SNIPER_DEFINITION,
} from "./weaponDefinitions.ts";

/**
 * Keyboard-accessible development loadout. Keeping this mapping on the
 * gameplay side prevents the proxy GLTF from becoming equipment truth.
 */
export function createDevelopmentLoadout(
  sniperDefinition: WeaponDefinition = SNIPER_DEFINITION
): LoadoutSystem {
  return new LoadoutSystem(
    [
      { inputSlot: 1, id: "primary", weapon: new WeaponSystem(sniperDefinition) },
      { inputSlot: 2, id: "secondary", weapon: new WeaponSystem(M4_DEFINITION) },
      { inputSlot: 3, id: "sidearm", weapon: new WeaponSystem(GLOCK_DEFINITION) },
      { inputSlot: 4, id: "support", weapon: new WeaponSystem(SAW_DEFINITION) },
    ],
    "primary"
  );
}
