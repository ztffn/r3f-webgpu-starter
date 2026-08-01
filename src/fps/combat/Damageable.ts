import type * as THREE from "three/webgpu";

export interface DamageInfo {
  readonly amount: number;
  readonly point: THREE.Vector3Like;
  readonly direction: THREE.Vector3Like;
  readonly sourceId: string;
  readonly shotSequence: number;
}

export interface DamageResult {
  readonly applied: number;
  readonly health: number;
  readonly destroyed: boolean;
}

export interface Damageable {
  readonly id: string;
  readonly maxHealth: number;
  readonly health: number;
  applyDamage(info: DamageInfo): DamageResult;
  reset(): void;
}

export type HealthChangedListener = (result: DamageResult, info: DamageInfo | null) => void;

export class HealthDamageable implements Damageable {
  readonly id: string;
  readonly maxHealth: number;
  private currentHealth: number;
  private readonly listener?: HealthChangedListener;

  constructor(id: string, maxHealth: number, listener?: HealthChangedListener) {
    if (!(maxHealth > 0)) throw new Error("Damageable maxHealth must be positive");
    this.id = id;
    this.maxHealth = maxHealth;
    this.currentHealth = maxHealth;
    this.listener = listener;
  }

  get health(): number {
    return this.currentHealth;
  }

  applyDamage(info: DamageInfo): DamageResult {
    const applied = Math.min(this.currentHealth, Math.max(0, info.amount));
    this.currentHealth -= applied;
    const result = {
      applied,
      health: this.currentHealth,
      destroyed: this.currentHealth === 0,
    };
    this.listener?.(result, info);
    return result;
  }

  reset(): void {
    this.currentHealth = this.maxHealth;
    this.listener?.({ applied: 0, health: this.currentHealth, destroyed: false }, null);
  }
}
