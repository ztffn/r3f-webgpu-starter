// The commit-on-release slider, shared by every dev-console tab that has one.
//
// Its own file because the markup carries the `data-dev` driver contract browser
// automation reads, and `dialGroup.tsx` states the rule that the contract must exist
// exactly once. It has already drifted once — a copied block lost `onPointerCancel`, so
// alt-tabbing mid-drag left an uncommitted value on screen looking live.

import { useState } from "react";

/**
 * A slider that commits on RELEASE rather than per tick, holding the dragged value itself.
 *
 * One implementation because the markup carries the `data-dev` driver contract that
 * browser automation reads, and `dialGroup.tsx` states the rule that the contract must
 * exist exactly once. It had already drifted: the foliage block was copied from the scale
 * block and lost `onPointerCancel`, so alt-tabbing mid-drag left an uncommitted value on
 * screen looking live. Sharing the markup is orthogonal to which dials ride the visual
 * wire — foliage is deliberately off `VISUAL_DIALS`, and still renders through this.
 */
export function CommitDial({
  devKey,
  label,
  min,
  max,
  step,
  hint,
  unit = "",
  value,
  onCommit,
}: {
  devKey: string;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
  unit?: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  // Null means "not being dragged", so a dial whose real value is 0 still reads its own
  // committed value rather than the placeholder.
  const [pending, setPending] = useState<number | null>(null);
  const live = pending ?? value;
  const commit = () => {
    if (pending !== null && pending !== value) onCommit(pending);
    setPending(null);
  };
  return (
    <label className="dial">
      <span className="dial-row">
        <span>{label}</span>
        <b data-dev={`readout-${devKey}`}>
          {live.toFixed(step < 1 ? 2 : 0)}
          {unit}
        </b>
      </span>
      <input
        type="range"
        data-dev={`dial-${devKey}`}
        data-dev-value={live}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={live}
        onChange={(e) => setPending(Number(e.target.value))}
        // Committing rebuilds the world (~a second) — on release, not per tick, or the
        // drag would stall the drag.
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        // Alt-tab mid-drag fires pointercancel, not pointerup: drop the uncommitted value
        // rather than leave a readout that looks live.
        onPointerCancel={() => setPending(null)}
      />
      <em>{hint}</em>
    </label>
  );
}
