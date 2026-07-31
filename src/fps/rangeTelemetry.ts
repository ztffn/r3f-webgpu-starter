// Compatibility facade for the original optic prototypes. New FPS presentation
// publishes through CombatTelemetry so the HUD reads one coherent snapshot.

import { combatTelemetry } from "./ui/CombatTelemetry";

export type RangeHitKind = "terrain" | "target" | "world";

export interface RangeSample {
  metres: number;
  kind: RangeHitKind;
}

export const RANGE_EVENT = "fps-range";

export function publishRange(range: RangeSample | null) {
  combatTelemetry.publishRange(range);
  window.dispatchEvent(new CustomEvent<RangeSample | null>(RANGE_EVENT, { detail: range }));
}
