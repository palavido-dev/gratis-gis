// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatDate } from '@/lib/i18n/format';
import type { SupportedLocale } from '@/lib/i18n/locales';
import type { WhatsNewEntry } from '@/lib/whats-new';

/**
 * Shared timeline list for the landing What's new card and the
 * `/whats-new` history page.  Presentation only — grouping and
 * jump-out links live with the callers.
 */
export function WhatsNewEntryList({
  entries,
  locale,
}: {
  entries: WhatsNewEntry[];
  locale: SupportedLocale;
}) {
  return (
    <ul className="space-y-4">
      {entries.map((e) => (
        <li
          key={`${e.release ?? 'none'}-${e.date}-${e.name}`}
          className="border-l-2 border-accent/40 pl-4"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <time
              dateTime={e.date}
              className="font-mono text-xs uppercase tracking-wide text-muted"
            >
              {formatChangelogDate(e.date, locale)}
            </time>
            <span className="text-sm font-medium text-ink-0">{e.name}</span>
          </div>
          <p className="mt-0.5 text-sm leading-snug text-muted">
            {e.description}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Render the YYYY-MM-DD heading date in a friendlier short form
 * (e.g. "Oct 28, 2026").  Falls back to the raw string if the input
 * doesn't parse, so a malformed entry still renders.
 */
export function formatChangelogDate(
  iso: string,
  locale: SupportedLocale,
): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDate(d, locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
