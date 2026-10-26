// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/server';
import { NotificationPreferencesForm } from './notification-preferences-form';

interface PreferencesPayload {
  channels: ('email')[];
  types: Array<{
    type: string;
    category: string;
    label: string;
    description: string;
    channels: ('email')[];
    preferences: Record<
      'email',
      { enabled: boolean; isDefault: boolean }
    >;
  }>;
}

export const metadata = { title: 'Notification preferences' };

/**
 * /settings/notifications: per-user opt-in / opt-out for every
 * notification type the platform fires. Server fetches the current
 * state through the BFF; the form below is a client component that
 * PUTs each toggle independently and reflects optimistic state so a
 * slow round-trip doesn't make the toggle feel laggy.
 */
export default async function NotificationsSettingsPage() {
  const locale = await getServerLocale();
  // apiFetch is the server-side helper; it talks to portal-api
  // directly, so the path it gets is the API's actual URL (no
  // `/api/portal/` BFF prefix). Other server components in this
  // app all use `/api/...` here -- this caller had the BFF path
  // by mistake, which made portal-api receive
  // `/api/portal/users/me/notification-preferences` and 404.
  const data = await apiFetch<PreferencesPayload>(
    '/api/users/me/notification-preferences',
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <Link
          href="/profile"
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('settingsNotifications.backToProfile', undefined, locale)}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {t('settingsNotifications.pageTitle', undefined, locale)}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          {t('settingsNotifications.pageIntro', undefined, locale)}
        </p>
      </header>

      <NotificationPreferencesForm initial={data} />
    </div>
  );
}
