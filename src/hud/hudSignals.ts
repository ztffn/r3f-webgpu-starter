// Per-frame HUD signals, deliberately outside React.
//
// The compass is the most motion-sensitive thing on screen, and `FlyState` is
// published every 0.15 s on purpose — at 6.7 Hz a compass visibly steps as you
// turn. So heading and pitch ride this mutable object instead: the camera rig
// writes it every frame, and the compass reads it in its own rAF loop and writes
// straight to a DOM style. No React state, no re-render, no throttle.
//
// Same shape of decision as writing uniform .value directly rather than through
// props (src/devtools/GrassPanel.tsx) — and for the same reason.

/**
 * Live camera orientation in radians.
 *
 * A plain mutable object, not a store with subscribers: there is exactly one
 * writer per frame and one reader per frame, and a notification per write would
 * cost more than the read it saves.
 */
export const hudSignals = {
  /** Compass heading. 0 = north, increasing clockwise (east is +π/2). */
  headingRadians: 0,
  /** Look pitch. Negative is down. Unused by the compass; the ranger uses it. */
  pitchRadians: 0,
};

/**
 * The rig's yaw is not a compass heading, and conflating the two is how a
 * compass ends up mirrored or 180° out.
 *
 * `FlyControls` and `MotorControls` both build their forward vector as
 * `(-sin yaw, ·, -cos yaw)`, so yaw 0 looks down NEGATIVE Z. With north at
 * negative Z that makes yaw 0 north, and a screen-right turn (yaw decreasing)
 * has to raise the bearing — hence the negation.
 *
 * That convention is owned by `lookDirection` in `src/motor/MotorTypes.ts`, which
 * is where it is written down for the motor and the wire. This function is the
 * same rule projected onto a bearing; if that one ever changes, this changes with
 * it, and `tests/hud/compass-tape.test.ts` is what fails.
 */
export function headingFromYaw(yawRadians: number): number {
  const turn = Math.PI * 2;
  return ((-yawRadians % turn) + turn) % turn;
}

/** Bearing in degrees, 0–360, for display. */
export function headingDegrees(): number {
  return (hudSignals.headingRadians * 180) / Math.PI;
}

/** "N", "NE", … for the 8 principal points, or a rounded bearing. */
export function cardinal(degrees: number): string | null {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(degrees / 45) % 8;
  // Only label a cardinal when the bearing is genuinely near it; otherwise the
  // strip would show "N" across a 45° span and read as a broken compass.
  return Math.abs(((degrees + 22.5) % 45) - 22.5) < 4 ? points[index]! : null;
}
