import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Bell } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { NotificationsAdminView, type Stats, type RecentRow } from './notifications-admin-view';

/**
 * Admin-only notifications status surface (#130). Shows queue
 * depth, last-24h sent / failed counts, average latency, a per-
 * type rollup, and a recent-activity table with per-row Retry on
 * failed entries. Pairs with the existing housekeeping dashboard
 * shape so admins find the same affordances across pages.
 */
export default async function AdminNotificationsPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  let stats: Stats | null = null;
  let recent: RecentRow[] = [];
  let error: string | null = null;
  try {
    [stats, recent] = await Promise.all([
      apiFetch<Stats>('/api/admin/notifications/stats'),
      apiFetch<RecentRow[]>('/api/admin/notifications/recent'),
    ]);
  } catch (err) {
    error =
      err instanceof Error
        ? err.message
        : 'Could not load notifications data.';
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
          <Bell className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Notifications
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Email delivery health for the platform. Stuck rows can be
            retried after fixing the underlying issue (typically SMTP
            credentials).
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">Could not load notifications data</p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : null}

      {stats ? (
        <NotificationsAdminView initialStats={stats} initialRecent={recent} />
      ) : null}
    </div>
  );
}
