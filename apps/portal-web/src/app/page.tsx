// SPDX-License-Identifier: AGPL-3.0-or-later
import { getServerSession } from 'next-auth';
import type { ItemType } from '@gratis-gis/shared-types';
import { authOptions } from '@/lib/auth';
import { getPortalUrl } from '@/lib/portal-url';
import { isSessionStale } from '@/lib/session-state';
import { loadWhatsNewEntries } from '@/lib/whats-new';
import { PublicLanding } from './public-landing';

/**
 * SoftwareApplication JSON-LD for the landing page (#SEO).  Makes
 * GratisGIS eligible for Google's software rich-result treatment
 * (screenshot, free tag, license, repo link in the SERP card).
 * The payload mirrors the openGraph metadata in layout.tsx so the
 * search engine has consistent signals across surfaces.  Inlined
 * here rather than in a shared lib because it's only meaningful on
 * the apex page; sub-routes shouldn't impersonate the application
 * description.
 */
function landingJsonLd() {
  const base = getPortalUrl();
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'GratisGIS',
    description:
      'Open-source, self-hosted geospatial portal. Web maps, app builder, offline field collection, visual tool builder. Built on PostGIS, MapLibre, and Next.js.',
    url: base,
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Geographic Information System',
    operatingSystem: 'Web, Linux server',
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    softwareVersion: 'pre-v1',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    author: {
      '@type': 'Organization',
      name: 'GratisGIS contributors',
      url: 'https://github.com/palavido-dev/gratis-gis',
    },
    codeRepository: 'https://github.com/palavido-dev/gratis-gis',
    programmingLanguage: ['TypeScript', 'SQL'],
    keywords: [
      'open source GIS',
      'self-hosted GIS portal',
      'web GIS',
      'PostGIS',
      'MapLibre',
      'geospatial portal',
      'web map server',
      'offline field data collection',
      'spatial data sharing',
    ].join(', '),
  };
}

export default async function HomePage(
  props: {
    searchParams?: Promise<{ preview?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);

  // #274: / always shows the public landing now, including for
  // authenticated visitors. This keeps the apex domain consistent
  // for every visitor (open-source marketing + the org's public
  // items) and gives signed-in folks an "Open my items" CTA that
  // takes them into their workspace. The previous tile-grid
  // dashboard ("Hey {name}, what would you like to do?") was a
  // lightweight redirect surface that doesn't earn its place when
  // the items list, top-bar nav, and per-item deep links are all
  // one click from anywhere else in the app.
  //
  // #255: ?preview=project remains as a dev override for forcing
  // the open-source project section on regardless of the
  // NEXT_PUBLIC_PROJECT_LANDING build flag (useful for layout
  // checks on prod before flipping the per-tenant flag).
  const previewProject = searchParams?.preview === 'project';
  const [data, whatsNew] = await Promise.all([
    loadLandingData(),
    // Cap at 5 entries so the landing card stays compact; the
    // markdown file can carry more for future-proofing.
    loadWhatsNewEntries(5),
  ]);
  return (
    <>
      {/* JSON-LD ships before the component so crawlers (which often
          read top-of-DOM before paint) pick it up reliably.  The
          script tag itself is invisible. */}
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(landingJsonLd()),
        }}
      />
      <PublicLanding
        data={data}
        whatsNew={whatsNew}
        forceProjectSection={previewProject}
        isAuthenticated={!!session}
        sessionStale={isSessionStale(session)}
      />
    </>
  );
}

/**
 * Fetches landing config + public items for unauthenticated
 * visitors. Hits the portal-api's public endpoint, which doesn't
 * require a session. On failure (API down, no orgs seeded, etc.)
 * falls back to a minimal zero-items payload so the page still
 * renders with a sensible default.
 */
async function loadLandingData(): Promise<
  React.ComponentProps<typeof PublicLanding>['data']
> {
  const base =
    process.env.PORTAL_API_URL ??
    process.env.NEXT_PUBLIC_PORTAL_API_URL ??
    'http://localhost:4000';
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/public/landing`, {
      // Server-to-server call; always fresh data (no Next cache)
      // since the admin might have just flipped a toggle.
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`landing fetch ${res.status}`);
    return (await res.json()) as React.ComponentProps<
      typeof PublicLanding
    >['data'];
  } catch {
    return {
      org: {
        slug: 'gratisgis',
        name: 'GratisGIS',
        title: 'GratisGIS',
        subtitle: null,
        heroImageUrl: null,
        showPublicItems: false,
      },
      items: [],
    };
  }
}

// Narrow helper for ItemType usage by callers; referenced to keep
// TypeScript from pruning the import when the shape is passed
// straight through to <PublicLanding>.
export type _LandingItemType = ItemType;
