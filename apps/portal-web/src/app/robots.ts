// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MetadataRoute } from 'next';
import { getPortalUrl } from '@/lib/portal-url';

/**
 * robots.txt generator (#SEO).  Next.js serves this at /robots.txt
 * automatically.  Lets crawlers index the public surface (landing,
 * /credits, /help/*), discourages crawling of the
 * authenticated workspace (item / form / admin routes), and points
 * at the sitemap so search engines can enumerate the public pages
 * in one request rather than discovering them by random crawl.
 *
 * Sitemap URL is built from NEXT_PUBLIC_PORTAL_URL so a self-host
 * deployment under its own origin still produces a valid absolute
 * sitemap reference -- relative sitemap URLs are technically legal
 * but several crawlers (Bing, Yandex) handle them poorly.
 */
export default function robots(): MetadataRoute.Robots {
  const base = getPortalUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/credits', '/help', '/help/'],
        // Auth-gated workspace surfaces are noise for search engines
        // and surfacing item ids in SERP would also leak share-link
        // shape.  Block them explicitly so a crawler that finds a
        // deep link from a backlink doesn't try to follow it.
        disallow: [
          '/items/',
          '/forms/',
          '/groups/',
          '/admin/',
          '/profile/',
          '/settings/',
          '/recently-deleted/',
          '/print/',
          '/field/',
          '/signin',
          '/api/',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
