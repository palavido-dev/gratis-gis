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
          // Contour brand (#173): flat warm paper + the contour-G
          // mark, matching the in-app --brand-* tokens.
          background: '#f6f3ea',
          color: '#2d3a2f',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <svg width="56" height="56" viewBox="0 0 64 64" fill="none">
              <path
                d="M34 8 C16 8 8 20 8 32 C8 46 19 56 34 56 C45 56 53 49 55 40 L37 40"
                stroke="#5c6b58"
                strokeWidth={5}
                strokeLinecap="round"
              />
              <path
                d="M34 18 C22 18 17 24 17 32 C17 40 24 46 34 46"
                stroke="#b08e62"
                strokeWidth={4}
                strokeLinecap="round"
              />
              <path
                d="M34 27 C29 27 26 29 26 32 C26 35 29 37 34 37"
                stroke="#8a5f66"
                strokeWidth={3.5}
                strokeLinecap="round"
              />
            </svg>
            <div
              style={{
                fontSize: 32,
                fontWeight: 500,
                letterSpacing: 4,
                color: '#5c6b58',
                textTransform: 'uppercase',
              }}
            >
              GratisGIS
            </div>
          </div>
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              lineHeight: 1.05,
              color: '#1f2920',
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
              color: '#5c6b58',
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
              color: '#7a8a7b',
              marginTop: 16,
            }}
          >
            <span>gratisgis.org</span>
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
