import Link from 'next/link';
import { Compass, LogIn, type LucideIcon } from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';
import {
  getItemTypeIcon,
  getItemTypeTileClasses,
} from '@/lib/item-type-icon';

/**
 * Public landing page for unauthenticated visitors. Renders outside
 * the main app-shell (see AppShell's no-session branch) so there is
 * no sidebar, no "Recently deleted", no nav hinting at content the
 * visitor can't see. The admin controls what this page looks like
 * through five knobs on the Organization row:
 *
 *   1. landingTitle        - falls back to org.name
 *   2. landingSubtitle     - optional
 *   3. landingHeroImageUrl - optional; hero band is a muted fill when unset
 *   4. landingShowPublicItems - toggle the content grid off for a clean
 *      logo + sign-in page (some orgs want this)
 *   5. landingFeaturedItemIds - ordered list shown first in the grid;
 *      empty falls back to all public items newest-first
 *
 * Data comes from GET /api/portal/public/landing which proxies to
 * the portal-api's unauthenticated /public/landing endpoint.
 */
interface LandingData {
  org: {
    slug: string;
    name: string;
    title: string;
    subtitle: string | null;
    heroImageUrl: string | null;
    showPublicItems: boolean;
  };
  items: Array<{
    id: string;
    title: string;
    description: string | null;
    type: ItemType;
    thumbnailUrl: string | null;
    updatedAt: string;
    tags: string[];
  }>;
}

interface Props {
  data: LandingData;
}

export function PublicLanding({ data }: Props) {
  const { org, items } = data;

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar orgName={org.name} />

      {/* Schema.org JSON-LD so search engines / open-data
          aggregators can index this page's public items. Server
          rendered (this is a server component) so the structured
          data is in the initial HTML response. See #66. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(buildLandingJsonLd(data), null, 0),
        }}
      />

      <Hero
        title={org.title}
        subtitle={org.subtitle}
        heroImageUrl={org.heroImageUrl}
      />

      {org.showPublicItems ? (
        <section className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">
          <div className="mb-6">
            <h2 className="text-xl font-semibold tracking-tight text-ink-0">
              Explore public content
            </h2>
            <p className="mt-1 text-sm text-muted">
              Datasets, maps, and apps {org.name} has shared publicly.
            </p>
          </div>

          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-surface-1 p-10 text-center">
              <p className="text-sm text-muted">
                Nothing has been shared publicly yet. If you have a
                portal account, sign in to see content shared with you.
              </p>
              <Link
                href="/signin"
                className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
              >
                <LogIn className="h-4 w-4" />
                Sign in
              </Link>
            </div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        // Logo-only mode: no grid, just a centered sign-in block so
        // the page has something the user can actually do.
        <section className="flex flex-1 items-center justify-center px-6 py-12">
          <Link
            href="/signin"
            className="inline-flex h-11 items-center gap-2 rounded-md bg-accent px-5 text-base font-medium text-accent-foreground shadow-card hover:opacity-90"
          >
            <LogIn className="h-5 w-5" />
            Sign in
          </Link>
        </section>
      )}

      <footer className="border-t border-border bg-surface-1 py-6 text-center text-xs text-muted">
        Powered by GratisGIS
      </footer>
    </div>
  );
}

function TopBar({ orgName }: { orgName: string }) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-surface-1 px-6">
      <div className="flex items-center gap-2">
        <Compass className="h-6 w-6 text-accent" />
        <span className="text-base font-semibold tracking-tight">
          {orgName}
        </span>
      </div>
      <Link
        href="/signin"
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </Link>
    </header>
  );
}

function Hero({
  title,
  subtitle,
  heroImageUrl,
}: {
  title: string;
  subtitle: string | null;
  heroImageUrl: string | null;
}) {
  const bg = heroImageUrl
    ? { backgroundImage: `url(${heroImageUrl})` }
    : undefined;
  return (
    <section
      className={`relative flex min-h-[280px] items-center justify-center bg-surface-2 px-6 py-16 text-center ${
        heroImageUrl ? 'bg-cover bg-center' : ''
      }`}
      style={bg}
    >
      {heroImageUrl ? (
        // Soft overlay so the title reads cleanly over any hero
        // image. Purely cosmetic; no functional impact when no image
        // is set.
        <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      ) : null}
      <div className="relative z-[1] max-w-3xl">
        <h1
          className={`text-4xl font-semibold tracking-tight sm:text-5xl ${
            heroImageUrl ? 'text-white' : 'text-ink-0'
          }`}
        >
          {title}
        </h1>
        {subtitle ? (
          <p
            className={`mt-3 text-base ${
              heroImageUrl ? 'text-white/90' : 'text-muted'
            }`}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ItemCard({ item }: { item: LandingData['items'][number] }) {
  const Icon: LucideIcon = getItemTypeIcon(item.type);
  const tile = getItemTypeTileClasses(item.type);
  return (
    <li>
      <Link
        href={`/items/${item.id}`}
        className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-raised"
      >
        {item.thumbnailUrl ? (
          // Hosted thumbnail path: MinIO-backed, origin-safe.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnailUrl}
            alt=""
            className="h-32 w-full object-cover"
          />
        ) : (
          <div
            className={`flex h-32 w-full items-center justify-center ${tile}`}
          >
            <Icon className="h-10 w-10" />
          </div>
        )}
        <div className="flex flex-1 flex-col p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">
            {item.type.replace(/_/g, ' ')}
          </p>
          <h3 className="mt-0.5 truncate text-sm font-semibold text-ink-0">
            {item.title}
          </h3>
          {item.description ? (
            <p className="mt-1 line-clamp-2 text-xs text-muted">
              {item.description}
            </p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------
// Schema.org JSON-LD for the landing page (#66)
// ---------------------------------------------------------------

/**
 * Build a Schema.org `CollectionPage` whose `mainEntity` is an
 * `ItemList` of every public item rendered on the page. Datasets
 * (data_layer / arcgis_service / wms_service / wfs_service) get
 * `Dataset` typing so open-data aggregators recognise them; other
 * item types fall back to the generic `CreativeWork`. Output is a
 * single JSON-LD blob the page injects via a server-rendered
 * <script type="application/ld+json"> tag.
 *
 * The portal does not have public item detail pages today, so the
 * URLs point at /items/<id>. Once the public detail surface lands,
 * the same shape can be lifted onto each item's own page (one
 * Dataset per page) without regenerating the structure here.
 */
function buildLandingJsonLd(
  data: LandingData,
): Record<string, unknown> {
  const dataLayerLike = new Set<ItemType>([
    'data_layer',
    'arcgis_service',
    'wms_service',
    'wfs_service',
  ]);

  const elements = data.items.map((item, index) => {
    const isDataset = dataLayerLike.has(item.type);
    const node: Record<string, unknown> = {
      '@type': isDataset ? 'Dataset' : 'CreativeWork',
      name: item.title,
      url: `/items/${item.id}`,
      dateModified: item.updatedAt,
    };
    if (item.description) node.description = item.description;
    if (item.tags.length > 0) node.keywords = item.tags;
    if (item.thumbnailUrl) node.image = item.thumbnailUrl;
    return {
      '@type': 'ListItem',
      position: index + 1,
      item: node,
    };
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: data.org.title,
    ...(data.org.subtitle ? { description: data.org.subtitle } : {}),
    publisher: {
      '@type': 'Organization',
      name: data.org.name,
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: data.items.length,
      itemListElement: elements,
    },
  };
}
