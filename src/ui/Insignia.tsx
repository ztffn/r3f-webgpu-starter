// Distant Front insignia — the brand mark, as inline SVG at two sizes.
//
// Inline rather than an image file for two reasons: it inherits currentColor so
// one mark serves the site skin and the HUD skin, and it costs no request on a
// cold landing page. Geometry follows design/distant-front-landing-modern-army —
// a shield, a dagger over ridgelines, and the rank chevrons either side.

export interface InsigniaProps {
  /** Rendered height in px. Width follows the aspect ratio. */
  size?: number;
  className?: string;
}

/**
 * Compact shield mark for navigation and avatars.
 *
 * `aria-hidden` because every caller pairs it with the wordmark as text — a
 * second accessible name would make a screen reader announce the brand twice.
 */
export function Insignia({ size = 34, className }: InsigniaProps) {
  return (
    <svg
      viewBox="0 0 100 120"
      width={(size * 100) / 120}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M50 4 94 28 88 92 50 116 12 92 6 28Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
      />
      <path
        d="M23 82 50 22 77 82 64 67 50 40 36 67Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
      />
      <path d="M48 34h4v52h-4zM44 84h12v6H44z" fill="currentColor" />
    </svg>
  );
}

/**
 * The full embroidered patch — tab, shield, dagger, ridgeline and chevrons.
 *
 * Only the landing hero uses it, at a size where the detail reads. It carries a
 * real accessible name because there it IS the page's primary image.
 */
export function InsigniaPatch({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 620 760"
      className={className}
      role="img"
      aria-labelledby="patch-title"
    >
      <title id="patch-title">Distant Front unit patch</title>
      <defs>
        <linearGradient id="patch-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#171915" />
          <stop offset="1" stopColor="#0c0d0b" />
        </linearGradient>
      </defs>

      {/* Curved name tab */}
      <path
        d="M128 24H492Q540 24 557 62L576 108Q584 128 563 132L57 132Q36 128 44 108L63 62Q80 24 128 24Z"
        fill="url(#patch-face)"
        stroke="#67674b"
        strokeWidth="13"
      />
      <text
        x="310"
        y="99"
        textAnchor="middle"
        fill="#d3c39b"
        fontFamily="Oxanium, sans-serif"
        fontSize="57"
        fontWeight="800"
        letterSpacing="4"
      >
        DISTANT FRONT
      </text>

      {/* Shield */}
      <path
        d="M87 154H533L571 210V555Q571 603 530 636L310 729 90 636Q49 603 49 555V210Z"
        fill="url(#patch-face)"
        stroke="#67674b"
        strokeWidth="14"
      />

      {/* Ridgeline, doubled so the khaki highlight sits on an olive mass */}
      <path
        d="M108 510 206 392 274 468 352 366 506 510"
        fill="none"
        stroke="#626348"
        strokeWidth="25"
        strokeLinejoin="miter"
      />
      <path
        d="M112 514 207 426 266 493 348 407 503 514"
        fill="none"
        stroke="#b8a373"
        strokeWidth="7"
      />

      {/* Rank chevrons */}
      <path
        d="M114 262h95M114 286h80M114 310h64M411 262h95M426 286h80M442 310h64"
        stroke="#858063"
        strokeWidth="12"
        strokeLinecap="square"
      />

      {/* Arrowhead enclosing the dagger */}
      <path
        d="M310 178 460 500 379 414 310 267 241 414 160 500Z"
        fill="none"
        stroke="#b8a373"
        strokeWidth="14"
        strokeLinejoin="miter"
      />

      {/* Dagger: blade, wrapped grip, pommel */}
      <path d="M297 224h26l-5 248 26 34-34 84-34-84 26-34Z" fill="#d9cfb2" />
      <path
        d="M272 481h76v18h-76zM286 499h48v18h-48zM286 520h48v18h-48zM286 541h48v18h-48z"
        fill="#b8a373"
      />
      <path d="M310 606 289 638h42Z" fill="#b8a373" />
      <path d="M265 638 295 664 310 650 325 664 355 638 333 682 310 694 287 682Z" fill="#858063" />
    </svg>
  );
}
