export class WeaponAimIndicator {
  centreXPixels = 0;
  centreYPixels = 0;
  coneRadiusPixels = 0;
  opacity = 0;
  visible = false;

  publish(
    centreXPixels: number,
    centreYPixels: number,
    coneRadiusPixels: number,
    opacity: number,
    visible: boolean
  ): void {
    this.centreXPixels = Number.isFinite(centreXPixels) ? centreXPixels : 0;
    this.centreYPixels = Number.isFinite(centreYPixels) ? centreYPixels : 0;
    this.coneRadiusPixels = Number.isFinite(coneRadiusPixels)
      ? Math.max(0, coneRadiusPixels)
      : 0;
    this.opacity = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0;
    this.visible = visible && this.opacity > 0;
  }

  clear(): void {
    this.visible = false;
    this.opacity = 0;
  }
}

export const weaponAimIndicator = new WeaponAimIndicator();
