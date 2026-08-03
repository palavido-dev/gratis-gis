// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { HousekeepingView, type HousekeepingBundle } from './housekeeping-view';
import {
  HousekeepingScheduleCard,
  type HousekeepingConfig,
  type HousekeepingRun,
} from './housekeeping-schedule-card';
import { StarterTemplatesCard } from './starter-templates-card';
import { StarterThemesCard } from './starter-themes-card';
import {
  OrphanedUploadsCard,
  type OrphanedUploadsReport,
} from './orphaned-uploads-card';
import {
  DanglingReferencesCard,
  type DanglingReferencesReport,
} from './dangling-references-card';

interface StarterStatusResponse {
  starters: Array<{
    kind: string;
    label: string;
    description: string;
    itemId: string | null;
  }>;
}

interface ThemeStarterStatusResponse {
  starters: Array<{
    kind: string;
    label: string;
    description: string;
    swatch: string;
    itemId: string | null;
  }>;
}

/**
 * Admin-only housekeeping dashboard: surfaces the items + users
 * that look like they could be retired or reviewed, with links
 * straight to the detail pages where the admin takes action.
 *
 * Streaming: the page shell paints synchronously; each card
 * fetches its data inside its own <Suspense> boundary so the
 * fast cards (schedule config, starter status) reach the screen
 * before the slow ones (storage scans, largest-tables, item
 * heuristics).  Without the per-card boundary the whole route
 * was blocked on the slowest of 13 parallel fetches and the
 * user clicked the link with no visible feedback for several
 * seconds.
 *
 * All heuristics: none of these lists gate any automatic
 * behaviour. The admin always makes the call.
 */
export default async function AdminHousekeepingPage() {
  // Role check stays synchronous because we redirect on failure.
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Housekeeping
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Items and accounts that look like they could be reviewed
            or retired. Everything below is a suggestion: click
            through to decide.
          </p>
        </div>
      </header>

      {/* Schedule card: small fetch (config + last-10 runs).  Almost
          always the fastest section to resolve. */}
      <Suspense fallback={<SkeletonCard />}>
        <div className="mb-6">
          <ScheduleSection />
        </div>
      </Suspense>

      {/* Starter app templates: single tiny query (seed_kind filter
          on the items table, lightweight). */}
      <Suspense fallback={<SkeletonCard />}>
        <div className="mb-6">
          <StarterTemplatesSection />
        </div>
      </Suspense>

      {/* Starter themes: same shape as templates, same speed. */}
      <Suspense fallback={<SkeletonCard />}>
        <div className="mb-6">
          <StarterThemesSection />
        </div>
      </Suspense>

      {/* Broken references (#217 companion): items pointing at item
          ids that no longer resolve. One org-wide dependency walk +
          one id lookup; fast, but keeps its own boundary like the
          rest. */}
      <Suspense fallback={<SkeletonCard />}>
        <div className="mb-6">
          <DanglingReferencesSection />
        </div>
      </Suspense>

      {/* Orphaned uploads: walks the MinIO prefixes + a reference
          scan, so it can take a few seconds on a big bucket. Own
          boundary keeps it off the critical path. Read-only fetch;
          the delete lives behind a confirm inside the card. */}
      <Suspense fallback={<SkeletonCard />}>
        <div className="mb-6">
          <OrphanedUploadsSection />
        </div>
      </Suspense>

      {/* The big bundle: storage + stale-items + stale-users +
          large-items + expiring-shares + expiring-users + largest-
          tables + largest-data-layers + summary.  Slowest of the
          four sections; kept whole so HousekeepingView keeps its
          existing bundle-shaped prop. */}
      <Suspense fallback={<SkeletonBigBundle />}>
        <BundleSection />
      </Suspense>
    </div>
  );
}

// ---- Streaming sections ----------------------------------------

async function ScheduleSection() {
  try {
    const [config, runs] = await Promise.all([
      apiFetch<HousekeepingConfig>('/api/admin/housekeeping/config'),
      apiFetch<HousekeepingRun[]>('/api/admin/housekeeping/runs?limit=10'),
    ]);
    return (
      <HousekeepingScheduleCard initialConfig={config} initialRuns={runs} />
    );
  } catch (err) {
    return <SectionError label="schedule" err={err} />;
  }
}

async function StarterTemplatesSection() {
  try {
    const resp = await apiFetch<StarterStatusResponse>(
      '/api/admin/app-templates/starter-status',
    );
    return <StarterTemplatesCard initial={resp.starters} />;
  } catch (err) {
    return <SectionError label="app templates" err={err} />;
  }
}

async function StarterThemesSection() {
  try {
    const resp = await apiFetch<ThemeStarterStatusResponse>(
      '/api/admin/themes/starter-status',
    );
    return <StarterThemesCard initial={resp.starters} />;
  } catch (err) {
    return <SectionError label="themes" err={err} />;
  }
}

async function DanglingReferencesSection() {
  try {
    const report = await apiFetch<DanglingReferencesReport>(
      '/api/admin/housekeeping/dangling-references',
    );
    return <DanglingReferencesCard initial={report} />;
  } catch (err) {
    return <SectionError label="broken references" err={err} />;
  }
}

async function OrphanedUploadsSection() {
  try {
    const report = await apiFetch<OrphanedUploadsReport>(
      '/api/admin/housekeeping/orphaned-uploads',
    );
    return <OrphanedUploadsCard initial={report} />;
  } catch (err) {
    return <SectionError label="orphaned uploads" err={err} />;
  }
}

async function BundleSection() {
  try {
    const [
      summary,
      staleItems,
      staleUsers,
      expiringShares,
      expiringUsers,
      storage,
      largestDataLayers,
    ] = await Promise.all([
      apiFetch<HousekeepingBundle['summary']>(
        '/api/admin/housekeeping/summary',
      ),
      apiFetch<HousekeepingBundle['staleItems']>(
        '/api/admin/housekeeping/stale-items',
      ),
      apiFetch<HousekeepingBundle['staleUsers']>(
        '/api/admin/housekeeping/stale-users',
      ),
      apiFetch<HousekeepingBundle['expiringShares']>(
        '/api/admin/housekeeping/expiring-shares',
      ),
      apiFetch<HousekeepingBundle['expiringUsers']>(
        '/api/admin/housekeeping/expiring-users',
      ),
      apiFetch<HousekeepingBundle['storage']>(
        '/api/admin/housekeeping/storage',
      ),
      apiFetch<HousekeepingBundle['largestDataLayers']>(
        '/api/admin/housekeeping/largest-data-layers',
      ),
    ]);
    const bundle: HousekeepingBundle = {
      summary,
      staleItems,
      staleUsers,
      expiringShares,
      expiringUsers,
      storage,
      largestDataLayers,
    };
    return <HousekeepingView bundle={bundle} />;
  } catch (err) {
    return <SectionError label="housekeeping data" err={err} />;
  }
}

// ---- Fallbacks --------------------------------------------------

function SkeletonCard() {
  return (
    <section className="animate-pulse rounded-lg border border-border bg-surface-1 p-5 shadow-card">
      <div className="mb-4 flex items-center gap-3">
        <span className="h-8 w-8 shrink-0 rounded-md bg-surface-2" />
        <span className="h-4 w-40 rounded-sm bg-surface-2" />
      </div>
      <div className="space-y-2">
        <div className="h-3 w-full rounded-sm bg-surface-2" />
        <div className="h-3 w-4/5 rounded-sm bg-surface-2" />
        <div className="h-3 w-2/3 rounded-sm bg-surface-2" />
      </div>
    </section>
  );
}

function SkeletonBigBundle() {
  return (
    <div className="space-y-6">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

function SectionError({ label, err }: { label: string; err: unknown }) {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      <p className="font-medium">Could not load {label}</p>
      <p className="mt-1 text-xs text-danger/90">{msg}</p>
    </div>
  );
}
