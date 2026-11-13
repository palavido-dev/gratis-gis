// SPDX-License-Identifier: AGPL-3.0-or-later
import { ImageResponse } from 'next/og';

/**
 * Open Graph + Twitter card image (#SEO).  Next.js serves this at
 * /opengraph-image at the size declared in `size` below; the URL
 * is auto-injected into `<meta property="og:image">` by the
 * framework so we don't have to declare it ourselves in
 * `metadata.openGraph.images`.
 *
 * Generated dynamically rather than shipped as a static .png so the
 * card visual lives next to the code that informs it (project
 * tagline, brand palette).  Replace this file with a hand-tuned PNG
 * later if you want pixel-perfect typography; the route name +
 * exports stay the same.
 *
 * Twitter reuses this same image via the `images` field in
 * `metadata.twitter` in layout.tsx (matching dimensions; Twitter
 * accepts the 1200x630 OG card directly).
 */

export const runtime = 'edge';
export const alt =
  'GratisGIS — open-source self-hosted geospatial portal';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          padding: '80px',
          // Cool paper + the contour-G mark in brand teal, matching
          // the in-app --brand-chart token.
          background: '#f6f7f9',
          color: '#161d27',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <svg width="56" height="56" viewBox="0 0 48 48" fill="none">
              <path
                d="M36.73 11.27A18 18 0 1 0 42 24H32"
                stroke="#0b6e69"
                strokeWidth={3.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M32.49 15.51A12 12 0 1 0 36 24"
                stroke="#0b6e69"
                strokeWidth={3.6}
                strokeLinecap="round"
                opacity={0.55}
              />
              <circle cx="24" cy="24" r="3.4" fill="#0b6e69" />
            </svg>
            <div
              style={{
                display: 'flex',
                fontSize: 32,
                fontWeight: 600,
                letterSpacing: 0,
              }}
            >
              <span style={{ color: '#161d27' }}>Gratis</span>
              <span style={{ color: '#0b6e69' }}>GIS</span>
            </div>
          </div>
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              lineHeight: 1.05,
              color: '#161d27',
              maxWidth: 980,
            }}
          >
            Open-source, self-hosted geospatial portal.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div
            style={{
              fontSize: 36,
              fontWeight: 500,
              color: '#0b6e69',
              lineHeight: 1.3,
              maxWidth: 1040,
            }}
          >
            Maps · app builder · offline field collection · visual
            tool builder. Built on PostGIS + MapLibre.
          </div>
          <div
            style={{
              display: 'flex',
              gap: 24,
              fontSize: 24,
              color: '#49505a',
              marginTop: 16,
            }}
          >
            <span>demo.gratisgis.org</span>
            <span>·</span>
            <span>AGPL-3.0</span>
            <span>·</span>
            <span>github.com/palavido-dev/gratis-gis</span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
