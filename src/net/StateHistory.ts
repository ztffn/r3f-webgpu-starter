// Per-tick capsule history — the rewind buffer behind lag compensation.
//
// The server records every player's blended capsule after each room step; a
// fire claim's viewTick then resolves near-field hitscan against the capsules
// the SHOOTER was rendering, not where targets have since moved. Fixed ring,
// no allocation per tick beyond first fill; capacity bounds the rewind window.

import type { CapsuleCandidate } from "./ServerWorldQuery.ts";

interface StoredCapsule {
  id: number;
  feetX: number;
  feetY: number;
  feetZ: number;
  radius: number;
  height: number;
}

const DEFAULT_CAPACITY_TICKS = 32;

export class StateHistory {
  private readonly capacity: number;
  private readonly ticks: Int32Array;
  private readonly slots: StoredCapsule[][];
  private readonly counts: Int32Array;

  constructor(capacityTicks = DEFAULT_CAPACITY_TICKS) {
    this.capacity = Math.max(1, Math.floor(capacityTicks));
    this.ticks = new Int32Array(this.capacity).fill(-1);
    this.counts = new Int32Array(this.capacity);
    this.slots = Array.from({ length: this.capacity }, () => []);
  }

  /** Records this tick's capsules, overwriting whatever the slot held before. */
  record(tick: number, capsules: Iterable<CapsuleCandidate>): void {
    const slot = tick % this.capacity;
    this.ticks[slot] = tick;
    const stored = this.slots[slot];
    let count = 0;
    for (const capsule of capsules) {
      // Reuse the previous entry object; a 64-player room records 3,840
      // capsules a second and none of them should be a fresh allocation.
      let entry = stored[count];
      if (entry === undefined) {
        entry = { id: 0, feetX: 0, feetY: 0, feetZ: 0, radius: 0, height: 0 };
        stored[count] = entry;
      }
      entry.id = capsule.id;
      entry.feetX = capsule.feetX;
      entry.feetY = capsule.feetY;
      entry.feetZ = capsule.feetZ;
      entry.radius = capsule.radius;
      entry.height = capsule.height;
      count += 1;
    }
    this.counts[slot] = count;
  }

  /**
   * The capsules recorded at `tick`, or null when that tick is gone from the
   * ring (too old, or the server just started). Null means the caller falls
   * back to live state — a worse answer than a rewound one, never a wrong one.
   */
  capsulesAt(tick: number): readonly CapsuleCandidate[] | null {
    const slot = tick % this.capacity;
    if (this.ticks[slot] !== tick) return null;
    return this.slots[slot].slice(0, this.counts[slot]);
  }
}
