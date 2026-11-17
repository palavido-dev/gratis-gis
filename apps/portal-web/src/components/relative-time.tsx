// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useFormat } from '@/lib/i18n/format';

/**
 * "3 minutes ago" in the active locale, with the full date and time on
 * hover. For places that render relative time but have no `useFormat`
 * of their own (server components included).
 */
export function RelativeTime({ value }: { value: string | number | Date }) {
  const fmt = useFormat();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return (
    <time dateTime={date.toISOString()} title={fmt.dateTime(date)}>
      {fmt.relativeTime(date)}
    </time>
  );
}
