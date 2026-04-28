import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { apiFetch } from '@/lib/api';
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
  const data = await apiFetch<PreferencesPayload>(
    '/api/portal/users/me/notification-preferences',
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <Link
          href="/profile"
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to profile
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Notification preferences
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Choose which events email you. The portal admin must enable
          email delivery at the platform level (NOTIFICATIONS_ENABLED)
          for any of these to actually fire.
        </p>
      </header>

      <NotificationPreferencesForm initial={data} />
    </div>
  );
}
