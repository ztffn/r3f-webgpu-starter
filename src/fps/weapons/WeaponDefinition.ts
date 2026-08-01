export type WeaponId = string;
export type WeaponSlotId = "primary" | "secondary" | "sidearm" | string;

export interface WeaponDefinition {
  readonly id: WeaponId;
  readonly displayName: string;
  readonly shot: {
    readonly type: "ballistic";
    readonly damage: number;
    readonly range: number;
    readonly roundsPerMinute: number;
    readonly muzzleVelocityMetresPerSecond: number;
    readonly ballisticCoefficientG1: number;
  };
  readonly ammo: {
    readonly magazineSize: number;
    readonly initialReserve: number;
  };
  readonly reload: {
    readonly durationSeconds: number;
  };
  readonly ads: {
    readonly enterSeconds: number;
    readonly exitSeconds: number;
  };
  readonly recoil: {
    readonly pitchRadians: number;
    readonly yawRadians: number;
  };
  readonly animations: {
    readonly fireSegment?: number;
    readonly reloadSegment?: number;
    readonly dryFireSegment?: number;
  };
}
