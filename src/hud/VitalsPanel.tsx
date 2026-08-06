// Vitals: health, stamina, hydration, armour.
//
// Only ONE of the four exists today. Health is real and server-authoritative
// (GameServer.applyDamage is the only thing that lowers it, and it reaches the
// client as `fly.net.health`); stamina, hydration and armour are systems that
// have not been built.
//
// So an unwired metric renders its label and an empty track with a dash, not a
// full bar. The reference layout is a 2x2 grid and keeping the grid is why they
// appear at all — but a HUD that shows 100% armour when there is no armour system
// is a HUD that will be believed, and docs/08 §8 invariant 5 is the same rule
// applied to grass: never report a stand-in as the real thing.

export type Vital = "health" | "stamina" | "hydration" | "armour";

export interface VitalsPanelProps {
  /** 0–1, or null when the metric has no source yet. */
  values: Record<Vital, number | null>;
}

const ROWS: { key: Vital; label: string; icon: string; tone: "olive" | "blue" }[] = [
  { key: "health", label: "Health", icon: "✚", tone: "olive" },
  { key: "hydration", label: "Hydration", icon: "◆", tone: "blue" },
  { key: "stamina", label: "Stamina", icon: "➟", tone: "olive" },
  { key: "armour", label: "Armour", icon: "⬟", tone: "blue" },
];

export function VitalsPanel({ values }: VitalsPanelProps) {
  return (
    <section className="hud-panel hud-vitals notched" data-dev="hud-vitals">
      {ROWS.map((row) => {
        const value = values[row.key];
        const wired = value !== null;
        const pct = wired ? Math.round(value * 100) : 0;
        return (
          <div
            className={`hud-metric tone-${row.tone}${wired ? "" : " unwired"}`}
            key={row.key}
            data-dev={`vital-${row.key}`}
            data-dev-value={wired ? String(pct) : "unwired"}
          >
            <span className="hud-metric-icon" aria-hidden="true">
              {row.icon}
            </span>
            <span className="hud-metric-label">{row.label}</span>
            {/* A meter REQUIRES aria-valuenow, and an unwired row has no value
                to give it — `aria-valuetext` alone does not satisfy the role, so
                the row was a non-conforming meter. Without the role it is what it
                actually is: a dash, with the empty dashed track beside it. */}
            <span
              className="hud-bar"
              {...(wired
                ? {
                    role: "meter" as const,
                    "aria-label": row.label,
                    "aria-valuenow": pct,
                    "aria-valuemin": 0,
                    "aria-valuemax": 100,
                    "aria-valuetext": `${pct}%`,
                  }
                : { "aria-hidden": true })}
            >
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="hud-metric-pct">{wired ? `${pct}%` : "—"}</span>
          </div>
        );
      })}
    </section>
  );
}
