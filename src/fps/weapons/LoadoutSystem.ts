import type { WeaponCommand, WeaponSlotId } from "./WeaponDefinition";
import type { WeaponHandlingContext } from "./WeaponHandling.ts";
import { WeaponSystem, type WeaponEvent, type WeaponSnapshot } from "./WeaponSystem.ts";

export interface LoadoutSlot {
  readonly inputSlot: number;
  readonly id: WeaponSlotId;
  readonly weapon: WeaponSystem;
}

export interface LoadoutSnapshot {
  readonly equippedSlot: WeaponSlotId;
  readonly switchingTo: WeaponSlotId | null;
  readonly weapon: WeaponSnapshot;
}

export type LoadoutEvent =
  | WeaponEvent
  | { readonly type: "weapon-switch-started"; readonly from: WeaponSlotId; readonly to: WeaponSlotId }
  | { readonly type: "weapon-equipped"; readonly slot: WeaponSlotId; readonly weaponId: string };

export class LoadoutSystem {
  private readonly slots = new Map<WeaponSlotId, WeaponSystem>();
  private readonly inputSlots = new Map<number, WeaponSlotId>();
  private readonly events: LoadoutEvent[] = [];
  private equippedSlot: WeaponSlotId;
  private switchingTo: WeaponSlotId | null = null;
  private switchRemaining = 0;

  constructor(slots: readonly LoadoutSlot[], initiallyEquipped: WeaponSlotId) {
    for (const slot of slots) {
      if (this.slots.has(slot.id)) throw new Error(`Duplicate loadout slot: ${slot.id}`);
      if (!Number.isInteger(slot.inputSlot) || slot.inputSlot < 1) {
        throw new Error(`Invalid numeric input slot: ${slot.inputSlot}`);
      }
      if (this.inputSlots.has(slot.inputSlot)) {
        throw new Error(`Duplicate numeric input slot: ${slot.inputSlot}`);
      }
      this.slots.set(slot.id, slot.weapon);
      this.inputSlots.set(slot.inputSlot, slot.id);
    }
    if (!this.slots.has(initiallyEquipped)) {
      throw new Error(`Initial loadout slot does not exist: ${initiallyEquipped}`);
    }
    this.equippedSlot = initiallyEquipped;
  }

  get equippedWeapon(): WeaponSystem {
    return this.slots.get(this.equippedSlot)!;
  }

  handleCommand(command: WeaponCommand): boolean {
    if (command.type === "equipSlot") return this.requestEquipInputSlot(command.slot);
    if (this.switchingTo) return false;
    this.equippedWeapon.handleCommand(command);
    // Promote accepted events now so a later equip command in the same ordered
    // batch cannot erase a shot that already consumed ammunition.
    this.collectWeaponEvents(this.equippedWeapon);
    return true;
  }

  setAdsWanted(wanted: boolean): void {
    if (this.switchingTo) return;
    this.equippedWeapon.setAdsWanted(wanted);
    this.collectWeaponEvents(this.equippedWeapon);
  }

  setHandlingContext(context: WeaponHandlingContext): void {
    if (this.switchingTo) return;
    this.equippedWeapon.setHandlingContext(context);
  }

  requestEquipInputSlot(inputSlot: number, durationSeconds = 0.35): boolean {
    const slot = this.inputSlots.get(inputSlot);
    return slot ? this.requestEquip(slot, durationSeconds) : false;
  }

  requestEquip(slot: WeaponSlotId, durationSeconds = 0.35): boolean {
    if (slot === this.equippedSlot || slot === this.switchingTo || !this.slots.has(slot)) {
      return false;
    }
    const from = this.equippedSlot;
    const previous = this.equippedWeapon;
    this.collectWeaponEvents(previous);
    previous.deactivate();
    this.events.push({ type: "weapon-switch-started", from, to: slot });
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
    for (const weapon of this.slots.values()) {
      weapon.update(dtSeconds);
      this.collectWeaponEvents(weapon);
    }
  }

  drainEvents(visitor: (event: LoadoutEvent) => void): void {
    for (const event of this.events) visitor(event);
    this.events.length = 0;
  }

  /** Used for blur and pointer-lock loss without cancelling a valid reload. */
  clearHeldTrigger(): void {
    for (const weapon of this.slots.values()) {
      weapon.handleCommand({ type: "triggerUp" });
    }
  }

  /** Component teardown must leave no held input, action, or queued event state. */
  deactivateAll(): void {
    for (const weapon of this.slots.values()) weapon.deactivate();
    this.events.length = 0;
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
    this.events.push({
      type: "weapon-equipped",
      slot: this.equippedSlot,
      weaponId: this.equippedWeapon.definition.id,
    });
  }

  private collectWeaponEvents(weapon: WeaponSystem): void {
    weapon.drainEvents((event) => this.events.push(event));
  }
}
