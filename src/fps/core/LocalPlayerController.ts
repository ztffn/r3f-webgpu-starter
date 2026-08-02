import * as THREE from "three/webgpu";
import { AuthoritativeAimState } from "./AuthoritativeAimState.ts";
import type { PlayerMotorSnapshot, PlayerStance } from "./PlayerMotor.ts";
import type { WeaponCommand } from "../weapons/WeaponDefinition.ts";

export interface LocalPlayerCommands {
  weaponCommands: WeaponCommand[];
  adsWanted: boolean;
  holdingBreath: boolean;
}

/**
 * Local input and player gameplay pose. It deliberately owns no mesh, mixer,
 * bone, scope material, or camera; adapters synchronize those at the edge.
 */
export class LocalPlayerController {
  readonly position = new THREE.Vector3();
  readonly aim = new AuthoritativeAimState();
  stance: PlayerStance = "stand";
  grounded = false;
  planarSpeedMetresPerSecond = 0;

  private readonly weaponCommands: WeaponCommand[] = [];
  private triggerHeld = false;
  private adsWanted = false;
  private holdingBreath = false;

  get wantsAds(): boolean {
    return this.adsWanted;
  }

  get isHoldingBreath(): boolean {
    return this.holdingBreath;
  }

  syncPresentationPose(pose: PlayerMotorSnapshot, aimDirection: THREE.Vector3Like): void {
    this.syncMotorPose(pose);
    this.syncAim(aimDirection);
  }

  syncMotorPose(pose: PlayerMotorSnapshot): void {
    this.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.stance = pose.stance;
    this.grounded = pose.grounded;
    this.planarSpeedMetresPerSecond = Number.isFinite(pose.planarSpeedMetresPerSecond)
      ? Math.max(0, pose.planarSpeedMetresPerSecond)
      : 0;
  }

  syncAim(aimDirection: THREE.Vector3Like): void {
    this.aim.set(this.position, aimDirection);
  }

  triggerDown(): void {
    if (this.triggerHeld) return;
    this.triggerHeld = true;
    this.weaponCommands.push({ type: "triggerDown" });
  }

  triggerUp(): void {
    if (!this.triggerHeld) return;
    this.triggerHeld = false;
    this.weaponCommands.push({ type: "triggerUp" });
  }

  requestReload(): void {
    this.weaponCommands.push({ type: "reload" });
  }

  selectFireMode(): void {
    this.weaponCommands.push({ type: "selectFireMode" });
  }

  equipSlot(slot: number): void {
    this.weaponCommands.push({ type: "equipSlot", slot });
  }

  toggleAds(): boolean {
    this.adsWanted = !this.adsWanted;
    if (!this.adsWanted) this.holdingBreath = false;
    return this.adsWanted;
  }

  setAdsWanted(wanted: boolean): void {
    this.adsWanted = wanted;
    if (!wanted) this.holdingBreath = false;
  }

  setHoldingBreath(holding: boolean): void {
    this.holdingBreath = this.adsWanted && holding;
  }

  consumeCommands(target: LocalPlayerCommands): void {
    target.weaponCommands.length = 0;
    target.weaponCommands.push(...this.weaponCommands);
    target.adsWanted = this.adsWanted;
    target.holdingBreath = this.holdingBreath;
    this.weaponCommands.length = 0;
  }

  resetInput(): void {
    this.triggerUp();
    this.holdingBreath = false;
  }
}
