// Weapon block: name, fire mode, silhouette, magazine and reserve.
//
// Every value here is real — it comes from combatTelemetry, which the weapon
// system already publishes. The silhouette is a CSS-composed shape rather than an
// icon font or an image: the silhouette is an authored render used as a CSS
// mask, so one greyscale asset paints in the phosphor palette rather than
// arriving as a fixed-colour picture.

import { weaponIconStyle } from "../ui/weaponIcons";
import type { WeaponId } from "../account/characters";

export interface WeaponPanelProps {
  /** Weapon id, for the silhouette. Null when nothing is equipped. */
  weaponId: WeaponId | null;
  name: string | null;
  fireMode: string | null;
  magazine: number | null;
  reserve: number | null;
}

export function WeaponPanel({ weaponId, name, fireMode, magazine, reserve }: WeaponPanelProps) {
  const icon = weaponId === null ? undefined : weaponIconStyle(weaponId);
  return (
    <section className="hud-panel hud-weapon notched" data-dev="hud-weapon">
      <header className="hud-weapon-head">
        <span data-dev="weapon-name">{name ?? "No weapon"}</span>
        {fireMode && (
          <span className="hud-amber" data-dev="weapon-firemode">
            {fireMode.toUpperCase()}
          </span>
        )}
      </header>

      {/* The real silhouette, masked so it takes the HUD's colour. Absent when
          the weapon has no render yet — a placeholder shape would be a picture
          of the wrong gun. */}
      {icon !== undefined && (
        <div
          className="hud-rifle weapon-silhouette"
          style={icon}
          aria-hidden="true"
          data-dev="weapon-icon"
        />
      )}

      <div className="hud-ammo" data-dev="weapon-ammo">
        <b>{magazine ?? "—"}</b>
        <span>/</span>
        {reserve ?? "—"}
      </div>
    </section>
  );
}
