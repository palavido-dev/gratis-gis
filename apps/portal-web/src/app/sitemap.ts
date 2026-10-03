// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MetadataRoute } from 'next';
import { loadAllDocs } from '@/lib/help/content';
import { portalUrl } from '@/lib/portal-url';

/**
 * sitemap.xml generator (#SEO).  Next.js serves this at
 * /sitemap.xml automatically.  Lists every public, indexable
 * page so search engines can enumerate them in one request:
 *
 *   - / (landing)
 *   - /credits              (third-party attribution)
 *   - /help                 (help index)
 *   - /help/<slug>          (every doc under content/help/)
 *
 * Auth-gated routes are excluded; robots.ts disallows them
 * explicitly.  lastModified for help docs comes from frontmatter
 * `lastUpdated` when present; otherwise the build time is used so
 * crawlers still see a reasonable freshness signal.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: portalUrl('/'),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: portalUrl('/credits'),
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.4,
    },
    {
      url: portalUrl('/help'),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
  ];

  // Pull every help doc and emit one entry per slug.  loadAllDocs
  // already filters and sorts them; here we just project to the
  // sitemap shape.  Skip the index doc (slug === 'index') so we
  // don't duplicate the /help entry above.
  let docEntries: MetadataRoute.Sitemap = [];
  try {
    const docs = await loadAllDocs();
    docEntries = docs
      .filter((d) => d.slug !== 'index')
      .map((d) => {
        const lastUpdatedRaw = (
          d.frontmatter as { lastUpdated?: string }
        ).lastUpdated;
        const lastModified = lastUpdatedRaw
          ? new Date(lastUpdatedRaw)
          : now;
        return {
          url: portalUrl(`/help/${d.slug}`),
          lastModified: Number.isFinite(lastModified.getTime())
            ? lastModified
            : now,
          changeFrequency: 'monthly' as const,
          priority: 0.7,
        };
      });
  } catch {
    // Content tree missing (unusual in prod, occasional in CI):
    // emit the static entries anyway so the sitemap is still
    // valid rather than failing the build.
  }

  return [...staticEntries, ...docEntries];
}
