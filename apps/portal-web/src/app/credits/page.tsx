// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { ArrowLeft, LogIn } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { authOptions } from '@/lib/auth';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';

/**
 * /credits - the project's "what we are built on" page. Lists the
 * load-bearing open-source projects GratisGIS uses with links back
 * to each project's home page.
 *
 * Public-shell layout so a visitor can land on the page directly
 * from a search engine or a shared link.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getServerLocale();
  return {
    // The root layout applies a "%s · GratisGIS" template; titles
    // declared here should NOT carry their own GratisGIS suffix or
    // they double up in the rendered <title>.
    title: t('credits.metaTitle', undefined, locale),
    description: t('credits.metaDescription', undefined, locale),
  };
}

interface StackRow {
  layerKey: string;
  /** Display name; can include multiple links (rendered comma-separated). */
  projects: Array<{ label: string; href: string }>;
}

const STACK: StackRow[] = [
  {
    layerKey: 'language',
    projects: [{ label: 'TypeScript', href: 'https://www.typescriptlang.org/' }],
  },
  {
    layerKey: 'backendApi',
    projects: [
      { label: 'Node.js', href: 'https://nodejs.org/' },
      { label: 'NestJS', href: 'https://nestjs.com/' },
    ],
  },
  {
    layerKey: 'database',
    projects: [
      { label: 'PostgreSQL', href: 'https://www.postgresql.org/' },
      { label: 'PostGIS', href: 'https://postgis.net/' },
    ],
  },
  {
    layerKey: 'ormMigrations',
    projects: [{ label: 'Prisma', href: 'https://www.prisma.io/' }],
  },
  {
    layerKey: 'authIdentity',
    projects: [{ label: 'Keycloak', href: 'https://www.keycloak.org/' }],
  },
  {
    layerKey: 'authorization',
    projects: [
      { label: 'Cedar', href: 'https://www.cedarpolicy.com/' },
    ],
  },
  {
    layerKey: 'objectStorage',
    projects: [{ label: 'MinIO', href: 'https://min.io/' }],
  },
  {
    layerKey: 'httpEdge',
    projects: [{ label: 'Caddy', href: 'https://caddyserver.com/' }],
  },
  {
    layerKey: 'tileServing',
    projects: [
      {
        label: 'pg_tileserv',
        href: 'https://github.com/CrunchyData/pg_tileserv',
      },
    ],
  },
  {
    layerKey: 'webFrontend',
    projects: [
      { label: 'Next.js', href: 'https://nextjs.org/' },
      { label: 'React', href: 'https://react.dev/' },
    ],
  },
  {
    layerKey: 'mapRendering',
    projects: [{ label: 'MapLibre GL', href: 'https://maplibre.org/' }],
  },
  {
    layerKey: 'drawingTools',
    projects: [
      { label: 'Terra Draw', href: 'https://terradraw.io/' },
    ],
  },
  {
    layerKey: 'tileBundles',
    projects: [
      { label: 'PMTiles', href: 'https://github.com/protomaps/PMTiles' },
    ],
  },
  {
    layerKey: 'spatialIndexing',
    projects: [{ label: 'h3-js', href: 'https://github.com/uber/h3-js' }],
  },
  {
    layerKey: 'osmPresetCatalog',
    projects: [
      {
        label: 'iD tagging schema',
        href: 'https://github.com/openstreetmap/id-tagging-schema',
      },
    ],
  },
  {
    layerKey: 'analysisEngine',
    projects: [{ label: 'DuckDB', href: 'https://duckdb.org/' }],
  },
  {
    layerKey: 'lidarPointClouds',
    projects: [
      { label: 'PDAL', href: 'https://pdal.io/' },
      { label: 'Untwine', href: 'https://github.com/hobuinc/untwine' },
      {
        label: 'maplibre-gl-lidar',
        href: 'https://github.com/opengeos/maplibre-gl-lidar',
      },
      { label: 'deck.gl', href: 'https://deck.gl/' },
    ],
  },
  {
    layerKey: 'imageryOnMaps',
    projects: [
      {
        label: 'maplibre-cog-protocol',
        href: 'https://github.com/geomatico/maplibre-cog-protocol',
      },
    ],
  },
  {
    layerKey: 'imagerySegmentation',
    projects: [
      {
        label: 'MobileSAM',
        href: 'https://github.com/ChaoningZhang/MobileSAM',
      },
    ],
  },
  {
    layerKey: 'elevationReadouts',
    projects: [
      { label: 'geotiff.js', href: 'https://geotiffjs.github.io/' },
    ],
  },
  {
    layerKey: 'analysisWorkerPackaging',
    projects: [
      { label: 'micromamba', href: 'https://mamba.readthedocs.io/' },
      { label: 'conda-forge', href: 'https://conda-forge.org/' },
    ],
  },
  {
    layerKey: 'kmlGpxImport',
    projects: [
      { label: '@tmcw/togeojson', href: 'https://github.com/tmcw/togeojson' },
    ],
  },
  {
    layerKey: 'rasterVectorIo',
    projects: [
      { label: 'GDAL', href: 'https://gdal.org/' },
      {
        label: 'gdal-async',
        href: 'https://github.com/mmomtchev/node-gdal-async',
      },
    ],
  },
  {
    layerKey: 'componentKit',
    projects: [{ label: 'shadcn/ui', href: 'https://ui.shadcn.com/' }],
  },
  {
    layerKey: 'charts',
    projects: [{ label: 'Recharts', href: 'https://recharts.org/' }],
  },
  {
    layerKey: 'icons',
    projects: [{ label: 'lucide-react', href: 'https://lucide.dev/' }],
  },
  {
    layerKey: 'styling',
    projects: [{ label: 'Tailwind CSS', href: 'https://tailwindcss.com/' }],
  },
  {
    layerKey: 'monorepo',
    projects: [
      { label: 'pnpm', href: 'https://pnpm.io/' },
      { label: 'Turborepo', href: 'https://turborepo.com/' },
    ],
  },
];

export default async function CreditsPage() {
  const locale = await getServerLocale();
  const session = await getServerSession(authOptions);
  const isAuthenticated = !!session;

  return (
    <div className="flex min-h-screen flex-col bg-surface-0">
      {!isAuthenticated ? <TopBar locale={locale} /> : null}

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('credits.backToHome', undefined, locale)}
        </Link>

        <header className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            {t('landing.builtOn', undefined, locale)}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-0 sm:text-4xl">
            {t('credits.headline', undefined, locale)}
          </h1>
          <p className="mt-3 text-base text-muted">
            {t('credits.intro', undefined, locale)}
          </p>
        </header>

        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink-0">
            {t('credits.stackTitle', undefined, locale)}
          </h2>
          <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface-1">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">
                    {t('credits.columnLayer', undefined, locale)}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t('credits.columnProjects', undefined, locale)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {STACK.map((row) => (
                  <tr
                    key={row.layerKey}
                    className="border-t border-border align-top"
                  >
                    <td className="px-3 py-2 text-ink-1">
                      {t(`credits.layers.${row.layerKey}`, undefined, locale)}
                    </td>
                    <td className="px-3 py-2">
                      {row.projects.map((p, i) => (
                        <span key={p.label}>
                          {i > 0 ? ', ' : ''}
                          <a
                            href={p.href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent hover:underline"
                          >
                            {p.label}
                          </a>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

      </main>

      <footer className="border-t border-border bg-surface-1 py-6 text-center text-xs text-muted">
        {t('credits.poweredBy', undefined, locale)} &middot;{' '}
        <Link href="/" className="underline hover:text-ink-0">
          {t('nav.home', undefined, locale)}
        </Link>
      </footer>
    </div>
  );
}

/**
 * Minimal public top bar so the chrome stays consistent across
 * the public surfaces.
 */
function TopBar({ locale }: { locale: Awaited<ReturnType<typeof getServerLocale>> }) {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface-1 px-6 pt-[env(safe-area-inset-top)] h-[calc(3.5rem+env(safe-area-inset-top))]">
      <Link href="/" className="flex items-center gap-2">
        <BrandMark size={26} />
        <span className="text-base font-semibold tracking-tight">
          GratisGIS
        </span>
      </Link>
      <Link
        href="/signin"
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
      >
        <LogIn className="h-4 w-4" />
        {t('nav.signIn', undefined, locale)}
      </Link>
    </header>
  );
}
