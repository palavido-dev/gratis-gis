import Link from 'next/link';
import { getServerSession } from 'next-auth';
import type { ItemType } from '@gratis-gis/shared-types';
import {
  ArrowRight,
  FileSpreadsheet,
  Layers,
  Map as MapIcon,
  Users,
} from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { PublicLanding } from './public-landing';

export default async function HomePage() {
  const session = await getServerSession(authOptions);

  // Unauthenticated visitors see a dedicated landing page outside
  // the app-shell. Landing data comes from the portal-api's public
  // endpoint: no session cookie, no bearer, anyone-on-the-internet
  // can read it.
  if (!session) {
    const data = await loadLandingData();
    return <PublicLanding data={data} />;
  }

  const name = session.user?.name?.split(' ')[0] ?? 'there';
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-10">
        <p className="text-sm text-muted">Hey {name},</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          What would you like to do?
        </h1>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          href="/items?scope=mine"
          title="My items"
          desc="Everything you own: maps, forms, apps, reports."
          icon={<Layers className="h-5 w-5" />}
        />
        <Tile
          href="/items?scope=all"
          title="Browse"
          desc="Items shared with you and your groups."
          icon={<MapIcon className="h-5 w-5" />}
        />
        <Tile
          href="/groups"
          title="Groups"
          desc="Collaborate with teammates and share content."
          icon={<Users className="h-5 w-5" />}
        />
        <Tile
          href="/reports"
          title="Reports"
          desc="Turn your data into shareable documents."
          icon={<FileSpreadsheet className="h-5 w-5" />}
        />
      </section>
    </div>
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

function Tile({
  href,
  title,
  desc,
  icon,
}: {
  href: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-lg border border-border bg-surface-1 p-5 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-raised"
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-accent/10 text-accent">
        {icon}
      </div>
      <div className="font-medium text-ink-1">{title}</div>
      <div className="mt-1 text-sm text-muted">{desc}</div>
      <div className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100">
        Open <ArrowRight className="h-3.5 w-3.5" />
      </div>
    </Link>
  );
}

// Narrow helper for ItemType usage by callers; referenced to keep
// TypeScript from pruning the import when the shape is passed
// straight through to <PublicLanding>.
export type _LandingItemType = ItemType;
