// Compass tape geometry — the pure half of the compass, so it can be tested.
//
// Split out of Compass.tsx deliberately. The component's own behaviour is a
// requestAnimationFrame loop writing a DOM transform, and rAF does not fire in a
// backgrounded or headless browser tab — which is exactly where this project's
// verification happens. That made "is the tape pointing the right way" an
// unverifiable claim. The arithmetic lives here instead, with no DOM and no React,
// and tests/hud/compass-tape.test.ts pins it.

/** Screen pixels per degree of bearing. Sets how fast the tape slides. */
export const PX_PER_DEGREE = 4;
/** A tick every 5°. */
export const TICK_DEGREES = 5;
/**
 * A label every 30°.
 *
 * 30° is the reference strip's cadence (`210 240 W 300 330 N`). 15° was tried and
 * is measurably worse at 4 px/degree: 60 px between numbers puts three digits in
 * about the width of four, and the strip reads as a texture rather than a scale.
 */
export const LABEL_DEGREES = 30;
/**
 * The tape spans three full turns, and the CENTRE turn is the one displayed.
 *
 * That is what lets the wrap from 359° to 0° happen a full turn off-screen in
 * either direction rather than as a visible jump through the index mark.
 */
export const TAPE_TURNS = 3;
export const TAPE_DEGREES = 360 * TAPE_TURNS;

const CARDINALS: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W" };

export interface CompassTick {
  /** Position along the tape, 0…1080. Not a bearing. */
  absolute: number;
  /** The bearing this tick marks, 0…359. */
  bearing: number;
  label: string | null;
  major: boolean;
  /** Offset from the tape's origin, in pixels. */
  offsetPx: number;
}

/**
 * Every tick on the tape.
 *
 * Pure and deterministic, so it is built once at module scope by the component
 * rather than per mount — 216 nodes is wasted work on a hot path.
 */
export function buildTicks(): CompassTick[] {
  const count = TAPE_DEGREES / TICK_DEGREES;
  return Array.from({ length: count }, (_, i) => {
    const absolute = i * TICK_DEGREES;
    const bearing = absolute % 360;
    const label =
      CARDINALS[bearing] ?? (absolute % LABEL_DEGREES === 0 ? String(bearing) : null);
    return {
      absolute,
      bearing,
      label,
      major: bearing % LABEL_DEGREES === 0,
      offsetPx: absolute * PX_PER_DEGREE,
    };
  });
}

/**
 * How far to slide the tape, in pixels, for a given heading.
 *
 * The tape's origin sits at the window centre (CSS `left: 50%`), so a tick at
 * `offsetPx` lands at `centre + offsetPx + tapeOffsetPx(heading)`. Offsetting by a
 * whole turn is what puts the CENTRE turn under the index mark: the tick whose
 * bearing equals the heading has `absolute = heading + 360`, and substituting that
 * gives exactly `centre`.
 */
export function tapeOffsetPx(headingDegrees: number): number {
  return -(headingDegrees + 360) * PX_PER_DEGREE;
}

/**
 * Where a tick lands on screen, relative to the compass window's centre.
 * Zero means "under the index mark". Exists so a test can assert the thing that
 * actually matters instead of re-deriving the transform.
 */
export function tickScreenOffset(tick: CompassTick, headingDegrees: number): number {
  return tick.offsetPx + tapeOffsetPx(headingDegrees);
}
