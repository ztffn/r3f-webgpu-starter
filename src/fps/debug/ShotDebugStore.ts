import type { ShotTrace } from "../../combat/ShotTrace.ts";

export interface ShotDebugSnapshot {
  readonly trace: ShotTrace | null;
}

type Listener = () => void;

const EMPTY: ShotDebugSnapshot = { trace: null };

export class ShotDebugStore {
  private snapshot: ShotDebugSnapshot = EMPTY;
  private readonly listeners = new Set<Listener>();

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ShotDebugSnapshot => this.snapshot;

  publish(trace: ShotTrace): void {
    this.replace({ trace });
  }

  clear(): void {
    if (this.snapshot === EMPTY) return;
    this.replace(EMPTY);
  }

  private replace(next: ShotDebugSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const shotDebugStore = new ShotDebugStore();
