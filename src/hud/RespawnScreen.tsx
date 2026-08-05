// The reload screen: who killed you, the kit you come back with, and the
// server's own respawn countdown. Shown between death and respawn in place of
// the old small death panel. The backdrop stays translucent on purpose — a dead
// player should still be able to read the ground they are about to respawn
// into, which is the one thing worth learning from dying.
//
// The slot list is the TARGET loadout pattern — primary / secondary / sidearm /
// support / aux / outfit — deliberately ahead of the systems behind it, so every
// screen that grows a loadout grows into the same shape (front-end leading).
// Rows a system exists for carry the real development kit; aux and outfit render
// unwired in the vitals panel's dashed convention, never with invented content.

import { useRespawnCountdown, type LocalDeath } from "../fps/useCombatFeed";
import { developmentKit } from "../fps/weapons/developmentLoadout";
import { weaponIconStyle } from "../ui/weaponIcons";
import type { WeaponId } from "../account/characters";
import "./respawn.css";

interface KitRow {
  role: string;
  /** Number key in the field, or null for a slot nothing binds yet. */
  key: number | null;
  weaponId: WeaponId | null;
  name: string | null;
  /** What the slot will hold once it exists — shown only on unwired rows. */
  aim?: string;
}

/** The dev kit's own slot ids are already the pattern's first four roles. */
const KIT: readonly KitRow[] = [
  ...developmentKit().map((slot) => ({
    role: slot.id,
    key: slot.inputSlot,
    weaponId: slot.definition.id as WeaponId,
    name: slot.definition.displayName,
  })),
  { role: "aux", key: null, weaponId: null, name: null, aim: "grenades · medic" },
  { role: "outfit", key: null, weaponId: null, name: null, aim: "ghillie · armor" },
];

export interface RespawnScreenProps {
  /** The local player's death, or null when alive — null renders nothing. */
  death: LocalDeath | null;
}

export function RespawnScreen({ death }: RespawnScreenProps) {
  // The SERVER's number — the same one it scheduled the respawn from — so the
  // clock and the respawn cannot disagree.
  const seconds = useRespawnCountdown(death);
  if (death === null || seconds === null) return null;

  return (
    <div className="respawn" data-dev="hud-death" role="status">
      <div className="respawn-stage notched">
        <header className="respawn-head">
          <span className="eyebrow">
            {death.killerName === null ? "You died" : "You were killed by"}
          </span>
          {death.killerName !== null && (
            <h1 data-dev="death-killer">{death.killerName}</h1>
          )}
        </header>

        <section className="respawn-kit" aria-label="Your kit">
          {KIT.map((slot) => {
            const icon = slot.weaponId === null ? undefined : weaponIconStyle(slot.weaponId);
            const unwired = slot.name === null;
            return (
              <div
                className={`respawn-slot${unwired ? " unwired" : ""}`}
                key={slot.role}
                data-dev={`respawn-slot-${slot.role}`}
                data-dev-value={unwired ? "unwired" : slot.weaponId ?? undefined}
              >
                <kbd>{slot.key ?? "·"}</kbd>
                {/* No authored silhouette means no shape at all, never a block. */}
                <span className="respawn-slot-icon" aria-hidden="true">
                  {icon && <i className="weapon-silhouette" style={icon} />}
                </span>
                <div>
                  <div className="respawn-slot-name">{slot.name ?? "—"}</div>
                  <div className="respawn-slot-role">
                    {slot.role}
                    {slot.aim !== undefined && ` · ${slot.aim}`}
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        <footer className="respawn-actions">
          <div className="respawn-count" data-dev="death-respawn" role="timer">
            Respawn in {seconds.toFixed(1)}s
          </div>
        </footer>
      </div>
    </div>
  );
}
