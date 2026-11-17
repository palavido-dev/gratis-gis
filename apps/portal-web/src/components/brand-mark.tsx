// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The GratisGIS brand mark: a "G" drawn as two contour rings around a
 * point. Server-safe; no client hooks.
 *
 * The mark is one colour, --brand-chart (teal), so it adapts to light
 * and dark mode with the app palette. The inner ring is the same
 * colour at reduced opacity.
 *
 * Two variants:
 * - full (default): outer G, inner ring and point; use at >= 20px.
 * - small: a heavier outer G and point, no inner ring, which stays
 *   legible at 16px. Prefer it below 20px.
 *
 * Static copies of the same geometry: public/icon.svg (PWA icon),
 * app/favicon.ico and app/apple-icon.png, app/opengraph-image.tsx,
 * the Keycloak login logo and the Android launcher icon. Keep them in
 * sync when the geometry changes.
 */

interface BrandMarkProps {
  /** Rendered box in px. Defaults to 24. */
  size?: number;
  variant?: 'full' | 'small';
  className?: string;
}

export function BrandMark({ size = 24, variant = 'full', className }: BrandMarkProps) {
  const color = 'hsl(var(--brand-chart))';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {variant === 'full' ? (
        <>
          <path
            d="M36.73 11.27A18 18 0 1 0 42 24H32"
            stroke={color}
            strokeWidth={3.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M32.49 15.51A12 12 0 1 0 36 24"
            stroke={color}
            strokeWidth={3.6}
            strokeLinecap="round"
            opacity={0.55}
          />
          <circle cx="24" cy="24" r="3.4" fill={color} />
        </>
      ) : (
        <>
          <path
            d="M36.73 11.27A18 18 0 1 0 42 24H32"
            stroke={color}
            strokeWidth={5.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="24" cy="24" r="4.4" fill={color} />
        </>
      )}
    </svg>
  );
}

/**
 * Mark + name lockup used by the app shell, landing chrome, and
 * auth-adjacent pages. The "GIS" tail takes the brand teal;
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
        <span className="text-brand-chart">GIS</span>
      </span>
    </span>
  );
}
