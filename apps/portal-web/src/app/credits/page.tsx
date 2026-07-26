// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { ArrowLeft, LogIn } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { authOptions } from '@/lib/auth';

/**
 * /credits - the project's "what we are built on" page. Lists the
 * load-bearing open-source projects GratisGIS uses with links back
 * to each project's home page.
 *
 * Public-shell layout matches /why so a visitor can land on
 * either page directly from a search engine or a shared link.
 */
export const metadata: Metadata = {
  // The root layout applies a "%s · GratisGIS" template; titles
  // declared here should NOT carry their own GratisGIS suffix or
  // they double up in the rendered <title>.
  title: 'Built on',
  description:
    'The open-source projects GratisGIS is built on, with links to each.',
};

interface StackRow {
  layer: string;
  /** Display name; can include multiple links (rendered comma-separated). */
  projects: Array<{ label: string; href: string }>;
}

const STACK: StackRow[] = [
  {
    layer: 'Language',
    projects: [{ label: 'TypeScript', href: 'https://www.typescriptlang.org/' }],
  },
  {
    layer: 'Backend API',
    projects: [
      { label: 'Node.js', href: 'https://nodejs.org/' },
      { label: 'NestJS', href: 'https://nestjs.com/' },
    ],
  },
  {
    layer: 'Database',
    projects: [
      { label: 'PostgreSQL', href: 'https://www.postgresql.org/' },
      { label: 'PostGIS', href: 'https://postgis.net/' },
    ],
  },
  {
    layer: 'ORM / migrations',
    projects: [{ label: 'Prisma', href: 'https://www.prisma.io/' }],
  },
  {
    layer: 'Auth / identity',
    projects: [{ label: 'Keycloak', href: 'https://www.keycloak.org/' }],
  },
  {
    layer: 'Authorization',
    projects: [
      { label: 'Cedar', href: 'https://www.cedarpolicy.com/' },
    ],
  },
  {
    layer: 'Object storage',
    projects: [{ label: 'MinIO', href: 'https://min.io/' }],
  },
  {
    layer: 'HTTP edge',
    projects: [{ label: 'Caddy', href: 'https://caddyserver.com/' }],
  },
  {
    layer: 'Tile serving',
    projects: [
      {
        label: 'pg_tileserv',
        href: 'https://github.com/CrunchyData/pg_tileserv',
      },
    ],
  },
  {
    layer: 'Web frontend',
    projects: [
      { label: 'Next.js', href: 'https://nextjs.org/' },
      { label: 'React', href: 'https://react.dev/' },
    ],
  },
  {
    layer: 'Map rendering',
    projects: [{ label: 'MapLibre GL', href: 'https://maplibre.org/' }],
  },
  {
    layer: 'Drawing tools',
    projects: [
      { label: 'Terra Draw', href: 'https://terradraw.io/' },
    ],
  },
  {
    layer: 'Tile bundles',
    projects: [
      { label: 'PMTiles', href: 'https://github.com/protomaps/PMTiles' },
    ],
  },
  {
    layer: 'Spatial indexing',
    projects: [{ label: 'h3-js', href: 'https://github.com/uber/h3-js' }],
  },
  {
    layer: 'OSM preset catalog',
    projects: [
      {
        label: 'iD tagging schema',
        href: 'https://github.com/openstreetmap/id-tagging-schema',
      },
    ],
  },
  {
    layer: 'Analysis engine',
    projects: [{ label: 'DuckDB', href: 'https://duckdb.org/' }],
  },
  {
    layer: 'Lidar / point clouds',
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
    layer: 'Imagery on maps',
    projects: [
      {
        label: 'maplibre-cog-protocol',
        href: 'https://github.com/geomatico/maplibre-cog-protocol',
      },
    ],
  },
  {
    layer: 'Imagery segmentation',
    projects: [
      {
        label: 'MobileSAM',
        href: 'https://github.com/ChaoningZhang/MobileSAM',
      },
    ],
  },
  {
    layer: 'Elevation readouts',
    projects: [
      { label: 'geotiff.js', href: 'https://geotiffjs.github.io/' },
    ],
  },
  {
    layer: 'Analysis worker packaging',
    projects: [
      { label: 'micromamba', href: 'https://mamba.readthedocs.io/' },
      { label: 'conda-forge', href: 'https://conda-forge.org/' },
    ],
  },
  {
    layer: 'KML / GPX import',
    projects: [
      { label: '@tmcw/togeojson', href: 'https://github.com/tmcw/togeojson' },
    ],
  },
  {
    layer: 'Raster / vector I/O',
    projects: [
      { label: 'GDAL', href: 'https://gdal.org/' },
      {
        label: 'gdal-async',
        href: 'https://github.com/mmomtchev/node-gdal-async',
      },
    ],
  },
  {
    layer: 'Component kit',
    projects: [{ label: 'shadcn/ui', href: 'https://ui.shadcn.com/' }],
  },
  {
    layer: 'Charts',
    projects: [{ label: 'Recharts', href: 'https://recharts.org/' }],
  },
  {
    layer: 'Icons',
    projects: [{ label: 'lucide-react', href: 'https://lucide.dev/' }],
  },
  {
    layer: 'Styling',
    projects: [{ label: 'Tailwind CSS', href: 'https://tailwindcss.com/' }],
  },
  {
    layer: 'Monorepo',
    projects: [
      { label: 'pnpm', href: 'https://pnpm.io/' },
      { label: 'Turborepo', href: 'https://turborepo.com/' },
    ],
  },
];

export default async function CreditsPage() {
  const session = await getServerSession(authOptions);
  const isAuthenticated = !!session;

  return (
    <div className="flex min-h-screen flex-col bg-surface-0">
      {!isAuthenticated ? <TopBar /> : null}

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to home
        </Link>

        <header className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Built on
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-0 sm:text-4xl">
            The open-source projects we stand on.
          </h1>
          <p className="mt-3 text-base text-muted">
            GratisGIS is built on the open-source projects below.
            Each row links to the project's home page; please consider
            supporting them directly.
          </p>
        </header>

        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink-0">
            Stack at a glance
          </h2>
          <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface-1">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Layer</th>
                  <th className="px-3 py-2 font-medium">Project(s)</th>
                </tr>
              </thead>
              <tbody>
                {STACK.map((row) => (
                  <tr
                    key={row.layer}
                    className="border-t border-border align-top"
                  >
                    <td className="px-3 py-2 text-ink-1">{row.layer}</td>
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
        Powered by GratisGIS &middot;{' '}
        <Link href="/" className="underline hover:text-ink-0">
          Home
        </Link>{' '}
        &middot;{' '}
        <Link href="/why" className="underline hover:text-ink-0">
          Why GratisGIS
        </Link>
      </footer>
    </div>
  );
}

/**
 * Same minimal top bar /why uses, kept in sync deliberately so the
 * two public pages have matching chrome.
 */
function TopBar() {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface-1 px-6 pt-[env(safe-area-inset-top)] [height:calc(3.5rem+env(safe-area-inset-top))]">
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
        Sign in
      </Link>
    </header>
  );
}
