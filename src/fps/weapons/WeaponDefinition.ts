import type { AmmunitionDefinition } from "./AmmunitionDefinition";

export type WeaponId = string;
export type WeaponSlotId = "primary" | "secondary" | "sidearm" | string;
export type FireMode = "semi" | "burst" | "auto";

export type WeaponCommand =
  | { readonly type: "triggerDown" }
  | { readonly type: "triggerUp" }
  | { readonly type: "selectFireMode" }
  | { readonly type: "reload" }
  | { readonly type: "equipSlot"; readonly slot: number };

export interface WeaponAccuracyDefinition {
  readonly mechanicalDispersionRadians: number;
  readonly hipDispersionRadians: number;
  readonly movementDispersionRadians: number;
  readonly airborneDispersionRadians: number;
  readonly bloomPerShotRadians: number;
  readonly maxBloomRadians: number;
  readonly bloomRecoveryPerSecond: number;
}

export interface WeaponRecoilDefinition {
  readonly pitchRadians: number;
  readonly yawRadians: number;
  readonly recoveryPerSecond: number;
  readonly maxPitchRadians: number;
  readonly maxYawRadians: number;
}

export interface WeaponDefinition {
  readonly id: WeaponId;
  readonly displayName: string;
  readonly shot: {
    readonly type: "ballistic";
    readonly damage: number;
    readonly range: number;
    readonly maxFlightSeconds: number;
    readonly roundsPerMinute: number;
    readonly ammunition: AmmunitionDefinition;
  };
  readonly ammo: {
    readonly magazineSize: number;
    readonly initialReserve: number;
  };
  readonly reload: {
    readonly durationSeconds: number;
  };
  readonly fireModes: {
    readonly supported: readonly FireMode[];
    readonly default: FireMode;
    readonly burstSize?: number;
  };
  readonly ads: {
    readonly enterSeconds: number;
    readonly exitSeconds: number;
  };
  readonly accuracy: WeaponAccuracyDefinition;
  readonly recoil: WeaponRecoilDefinition;
}
