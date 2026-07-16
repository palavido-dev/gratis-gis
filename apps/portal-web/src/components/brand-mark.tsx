// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The GratisGIS brand mark (#173): a "G" drawn as nested elevation
 * contours in the Contour palette (sage, clay, mauve). Server-safe;
 * no client hooks.
 *
 * Colors resolve through the --brand-* tokens defined in
 * globals.css, so the mark adapts to light/dark automatically and
 * stays in lockstep with the app palette.
 *
 * Two variants:
 * - full (default): three contours; use at >= 20px.
 * - small: a single heavier contour + crossbar that survives 16px
 *   favicons, badges, and low-DPI trays. Prefer it below 20px.
 *
 * Static exports of the same geometry live in public/icon.svg (PWA
 * icon) and app/opengraph-image.tsx (social card); keep the three
 * in sync when the geometry changes.
 */

interface BrandMarkProps {
  /** Rendered box in px. Defaults to 24. */
  size?: number;
  variant?: 'full' | 'small';
  className?: string;
}

export function BrandMark({ size = 24, variant = 'full', className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {variant === 'full' ? (
        <>
          <path
            d="M34 8 C16 8 8 20 8 32 C8 46 19 56 34 56 C45 56 53 49 55 40 L37 40"
            stroke="hsl(var(--brand-sage))"
            strokeWidth={5}
            strokeLinecap="round"
          />
          <path
            d="M34 18 C22 18 17 24 17 32 C17 40 24 46 34 46"
            stroke="hsl(var(--brand-clay))"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <path
            d="M34 27 C29 27 26 29 26 32 C26 35 29 37 34 37"
            stroke="hsl(var(--brand-mauve))"
            strokeWidth={3.5}
            strokeLinecap="round"
          />
        </>
      ) : (
        <path
          d="M34 10 C18 10 10 21 10 32 C10 45 20 54 34 54 C44 54 51 48 53 40 L36 40"
          stroke="hsl(var(--brand-sage))"
          strokeWidth={8}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/**
 * Mark + name lockup used by the app shell, landing chrome, and
 * auth-adjacent pages. The "GIS" tail takes the sage brand color;
 * "Gratis" stays ink so the lockup works on any surface.
 */
export function BrandWordmark({
  markSize = 24,
  className,
}: {
  markSize?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <BrandMark size={markSize} />
      <span className="text-base font-semibold tracking-tight text-ink-1">
        Gratis
        <span style={{ color: 'hsl(var(--brand-sage))' }}>GIS</span>
      </span>
    </span>
  );
}
