// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';
import { Bell } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { loadNotificationsAdmin } from '@/lib/admin-notifications-load';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import {
  NotificationsAdminView,
  type Stats,
  type RecentRow,
  type SmtpState,
  type DefaultsRow,
  type TemplateOverrideRow,
} from './notifications-admin-view';

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
  const locale = await getServerLocale();

  // A 403 on the install-wide calls (stats, recent, SMTP) hides those
  // sections only; see loadNotificationsAdmin.
  const loaded = await loadNotificationsAdmin({
    stats: () => apiFetch<Stats>('/api/admin/notifications/stats'),
    recent: () => apiFetch<RecentRow[]>('/api/admin/notifications/recent'),
    smtp: () => apiFetch<SmtpState>('/api/admin/notifications/smtp'),
    defaults: () =>
      apiFetch<{ rows: DefaultsRow[] }>('/api/admin/notifications/defaults'),
    templates: () =>
      apiFetch<{ rows: TemplateOverrideRow[] }>(
        '/api/admin/notifications/templates',
      ),
  });
  const { operator, stats, recent, smtp, defaults, templateOverrides } = loaded;
  const error: string | null =
    loaded.error === null
      ? null
      : loaded.error instanceof Error
        ? loaded.error.message
        : t('adminNotifications.loadErrorFallback', undefined, locale);

  return (
    <div className="w-full max-w-5xl pb-10 pt-4">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Bell className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('adminHome.cards.email.title', undefined, locale)}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {t('adminNotifications.pageIntro', undefined, locale)}
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p className="font-medium">
            {t('adminNotifications.loadErrorTitle', undefined, locale)}
          </p>
          <p className="mt-1 text-danger/90">{error}</p>
        </div>
      ) : null}

      {defaults && templateOverrides ? (
        <NotificationsAdminView
          operator={operator}
          initialStats={stats}
          initialRecent={recent}
          initialSmtp={smtp}
          initialDefaults={defaults}
          initialTemplateOverrides={templateOverrides}
        />
      ) : null}
    </div>
  );
}
