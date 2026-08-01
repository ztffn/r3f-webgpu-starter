import type { WeaponSlotId } from "./WeaponDefinition";
import { WeaponSystem, type WeaponEvent, type WeaponSnapshot } from "./WeaponSystem.ts";

export interface LoadoutSlot {
  readonly id: WeaponSlotId;
  readonly weapon: WeaponSystem;
}

export interface LoadoutSnapshot {
  readonly equippedSlot: WeaponSlotId;
  readonly switchingTo: WeaponSlotId | null;
  readonly weapon: WeaponSnapshot;
}

export class LoadoutSystem {
  private readonly slots = new Map<WeaponSlotId, WeaponSystem>();
  private equippedSlot: WeaponSlotId;
  private switchingTo: WeaponSlotId | null = null;
  private switchRemaining = 0;

  constructor(slots: readonly LoadoutSlot[], initiallyEquipped: WeaponSlotId) {
    for (const slot of slots) {
      if (this.slots.has(slot.id)) throw new Error(`Duplicate loadout slot: ${slot.id}`);
      this.slots.set(slot.id, slot.weapon);
    }
    if (!this.slots.has(initiallyEquipped)) {
      throw new Error(`Initial loadout slot does not exist: ${initiallyEquipped}`);
    }
    this.equippedSlot = initiallyEquipped;
  }

  get equippedWeapon(): WeaponSystem {
    return this.slots.get(this.equippedSlot)!;
  }

  requestEquip(slot: WeaponSlotId, durationSeconds = 0.35): boolean {
    if (slot === this.equippedSlot || !this.slots.has(slot)) return false;
    this.switchingTo = slot;
    this.switchRemaining = Math.max(0, durationSeconds);
    if (this.switchRemaining === 0) this.finishSwitch();
    return true;
  }

  update(dtSeconds: number): void {
    if (this.switchingTo) {
      this.switchRemaining = Math.max(0, this.switchRemaining - Math.max(0, dtSeconds));
      if (this.switchRemaining === 0) this.finishSwitch();
    }
    this.equippedWeapon.update(dtSeconds);
  }

  drainEvents(visitor: (event: WeaponEvent) => void): void {
    this.equippedWeapon.drainEvents(visitor);
  }

  getSnapshot(): LoadoutSnapshot {
    return {
      equippedSlot: this.equippedSlot,
      switchingTo: this.switchingTo,
      weapon: this.equippedWeapon.getSnapshot(),
    };
  }

  private finishSwitch(): void {
    if (this.switchingTo) this.equippedSlot = this.switchingTo;
    this.switchingTo = null;
    this.switchRemaining = 0;
  }
}
