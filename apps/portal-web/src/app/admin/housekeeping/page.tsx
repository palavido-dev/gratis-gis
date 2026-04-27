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

/**
 * Admin-only housekeeping dashboard: surfaces the items + users
 * that look like they could be retired or reviewed, with links
 * straight to the detail pages where the admin takes action.
 *
 * All heuristics: none of these lists gate any automatic
 * behaviour. The admin always makes the call.
 */
export default async function AdminHousekeepingPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  let bundle: HousekeepingBundle | null = null;
  let scheduleConfig: HousekeepingConfig | null = null;
  let scheduleRuns: HousekeepingRun[] = [];
  let error: string | null = null;
  try {
    const [
      summary,
      staleItems,
      staleUsers,
      largeItems,
      expiringShares,
      expiringUsers,
      config,
      runs,
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
      apiFetch<HousekeepingBundle['largeItems']>(
        '/api/admin/housekeeping/large-items',
      ),
      apiFetch<HousekeepingBundle['expiringShares']>(
        '/api/admin/housekeeping/expiring-shares',
      ),
      apiFetch<HousekeepingBundle['expiringUsers']>(
        '/api/admin/housekeeping/expiring-users',
      ),
      apiFetch<HousekeepingConfig>('/api/admin/housekeeping/config'),
      apiFetch<HousekeepingRun[]>(
        '/api/admin/housekeeping/runs?limit=10',
      ),
    ]);
    bundle = {
      summary,
      staleItems,
      staleUsers,
      largeItems,
      expiringShares,
      expiringUsers,
    };
    scheduleConfig = config;
    scheduleRuns = runs;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Could not load housekeeping data.';
  }

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

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">Could not load housekeeping data</p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : null}

      {scheduleConfig ? (
        <div className="mb-6">
          <HousekeepingScheduleCard
            initialConfig={scheduleConfig}
            initialRuns={scheduleRuns}
          />
        </div>
      ) : null}

      {bundle ? <HousekeepingView bundle={bundle} /> : null}
    </div>
  );
}
