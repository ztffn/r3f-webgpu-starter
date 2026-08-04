// Weapon block: name, fire mode, silhouette, magazine and reserve.
//
// Every value here is real — it comes from combatTelemetry, which the weapon
// system already publishes. The silhouette is a CSS-composed shape rather than an
// icon font or an image: it has to tint with the HUD palette, and at this size a
// handful of divs reads better than a downscaled sprite.

export interface WeaponPanelProps {
  name: string | null;
  fireMode: string | null;
  magazine: number | null;
  reserve: number | null;
}

export function WeaponPanel({ name, fireMode, magazine, reserve }: WeaponPanelProps) {
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

      <div className="hud-rifle" aria-hidden="true">
        <i className="stock" />
        <i className="body" />
        <i className="barrel" />
        <i className="mag" />
        <i className="grip" />
      </div>

      <div className="hud-ammo" data-dev="weapon-ammo">
        <b>{magazine ?? "—"}</b>
        <span>/</span>
        {reserve ?? "—"}
      </div>
    </section>
  );
}
