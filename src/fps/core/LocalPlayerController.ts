import * as THREE from "three/webgpu";
import { AuthoritativeAimState } from "./AuthoritativeAimState";
import type { PlayerMotorSnapshot, PlayerStance } from "./PlayerMotor";

export interface LocalPlayerCommands {
  triggerPresses: number;
  reloadRequested: boolean;
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

  private triggerPresses = 0;
  private reloadRequested = false;
  private adsWanted = false;
  private holdingBreath = false;

  get wantsAds(): boolean {
    return this.adsWanted;
  }

  get isHoldingBreath(): boolean {
    return this.holdingBreath;
  }

  syncPresentationPose(pose: PlayerMotorSnapshot, aimDirection: THREE.Vector3Like): void {
    this.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.stance = pose.stance;
    this.grounded = pose.grounded;
    this.aim.set(this.position, aimDirection);
  }

  pressTrigger(): void {
    this.triggerPresses += 1;
  }

  requestReload(): void {
    this.reloadRequested = true;
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
    target.triggerPresses = this.triggerPresses;
    target.reloadRequested = this.reloadRequested;
    target.adsWanted = this.adsWanted;
    target.holdingBreath = this.holdingBreath;
    this.triggerPresses = 0;
    this.reloadRequested = false;
  }

  resetInput(): void {
    this.triggerPresses = 0;
    this.reloadRequested = false;
    this.holdingBreath = false;
  }
}
