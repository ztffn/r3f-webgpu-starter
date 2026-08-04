import type { ImpactEvent } from "../../combat/ImpactEvent.ts";

type Listener = (event: ImpactEvent) => void;

/** Synchronous presentation edge; it stores no gameplay state and allocates no queue. */
export class ImpactEffectBus {
  private readonly listeners = new Set<Listener>();

  readonly publish = (event: ImpactEvent): void => {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // Presentation failure must not unwind the authoritative projectile loop.
        console.error("Impact presentation failed", error);
      }
    }
  };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const impactEffectBus = new ImpactEffectBus();
