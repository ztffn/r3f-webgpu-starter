// Scope rangefinder telemetry deliberately crosses the R3F/DOM boundary as a
// small browser event. The HUD stays independent of the scene tree, while the
// raycaster remains next to the scope camera that defines its centre line.

export type RangeHitKind = "terrain" | "target";

export interface RangeSample {
  metres: number;
  kind: RangeHitKind;
}

export const RANGE_EVENT = "fps-range";

export function publishRange(range: RangeSample | null) {
  window.dispatchEvent(new CustomEvent<RangeSample | null>(RANGE_EVENT, { detail: range }));
}
