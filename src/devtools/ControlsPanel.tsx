// "Controls" tab — the keyboard and mouse legend.
//
// Only the bindings that exist are listed, and the FPS-only ones are gated on the
// scope demo rather than shown greyed out: a legend that lists a key doing nothing
// is worse than one that is short, because the first thing anyone does with a new
// binding is press it and conclude the feature is broken.

export interface ControlsPanelProps {
  fpsMode: boolean;
}

export function ControlsPanel({ fpsMode }: ControlsPanelProps) {
  return (
    <>
      <span className="eyebrow dev-group">Movement and view</span>
      <dl className="rows legend">
        <dt>{fpsMode ? "Mouse" : "Drag"}</dt>
        <dd>{fpsMode ? "click once, then look" : "look"}</dd>
        <dt>W A S D</dt>
        <dd>move</dd>
        <dt>Q / E</dt>
        <dd>down / up</dd>
        <dt>Wheel</dt>
        <dd>fly speed</dd>
        <dt>Shift</dt>
        <dd>{fpsMode ? "sprint / ADS breath" : "boost ×4"}</dd>
        <dt>Space</dt>
        <dd>jump (motor)</dd>
        <dt>G</dt>
        <dd>foot / fly</dd>
        <dt>X C Z</dt>
        <dd>stand / crouch / prone</dd>
        <dt>V</dt>
        <dd>third-person collider capsule (motor)</dd>
        <dt>`</dt>
        <dd>this console</dd>
      </dl>

      <span className="eyebrow dev-group">Weapon</span>
      <dl className="rows legend">
        <dt>Left click</dt>
        <dd>fire (scope demo)</dd>
        <dt>Right click</dt>
        <dd>scope aim</dd>
        <dt>R / T</dt>
        <dd>reload / reset targets</dd>
        {fpsMode ? (
          <>
            <dt>1 / 2 / 3 / 4</dt>
            <dd>sniper / M4 / Glock / SAW</dd>
            <dt>B</dt>
            <dd>select fire mode</dd>
            <dt>Z / X (ADS)</dt>
            <dd>zoom in / out</dd>
            <dt>↑ ↓ (ADS)</dt>
            <dd>scope zero</dd>
            <dt>← → (ADS)</dt>
            <dd>windage ±0.1 mil</dd>
            <dt>0 (ADS)</dt>
            <dd>reset turrets</dd>
          </>
        ) : (
          <>
            <dt>1–8</dt>
            <dd>weapon action (weaponanim=1)</dd>
          </>
        )}
      </dl>

      <span className="eyebrow dev-group">URLs</span>
      <dl className="rows legend">
        <dt>?scene=scope&amp;motor=1</dt>
        <dd>weapon on a collided body</dd>
        <dt>&amp;net=1</dt>
        <dd>authoritative server (npm run game:server)</dd>
        <dt>?bench=1</dt>
        <dd>fixed vantage, published sample</dd>
        <dt>?debug=1</dt>
        <dd>open this console at load</dd>
      </dl>
    </>
  );
}
