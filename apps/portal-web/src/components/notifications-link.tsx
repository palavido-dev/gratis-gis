// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useT } from '@/lib/i18n/locale-context';

/** Signed-in notification preferences. The shell bell used to be a
 *  button with no destination. */
export function NotificationsLink() {
  const t = useT();
  return (
    <Link
      href="/settings/notifications"
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2 focus:outline-hidden focus:ring-2 focus:ring-accent/30"
      aria-label={t('shell.notificationsLabel')}
    >
      <Bell className="h-4 w-4" />
    </Link>
  );
}
