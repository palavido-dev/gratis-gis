// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure helpers for the Responses form view (responses/form-view.tsx).
 * Kept out of the component so the jest suite, which covers src/lib
 * only, can exercise them.
 */
import type { Question } from '@gratis-gis/form-schema';
import type { PickListData } from '@gratis-gis/shared-types';

import { formatDate, formatDateTime } from './i18n/format';
import type { SupportedLocale } from './i18n/locales';

/**
 * Label for a stored choice value. Inline `choices` win; a question
 * backed by a pick list falls back to that list's entries. Returns
 * null when nothing matches so the caller can show the raw value.
 */
export function labelForChoice(
  q: Question,
  code: unknown,
  pickLists: Record<string, PickListData>,
): string | null {
  if (q.type !== 'select-one' && q.type !== 'select-many') return null;
  const wanted = String(code);
  if (Array.isArray(q.choices)) {
    const hit = q.choices.find((c) => c.value === wanted);
    if (hit) return hit.label;
  }
  const list = q.pickListId ? pickLists[q.pickListId] : undefined;
  if (list && Array.isArray(list.entries)) {
    const hit = list.entries.find((e) => e.code === wanted);
    if (hit) return hit.label;
  }
  return null;
}

/**
 * Format a date, time or datetime answer. The form runtime stores the
 * raw input strings: `YYYY-MM-DD`, `HH:MM` and `YYYY-MM-DDTHH:MM`.
 * A date-only string handed to `new Date()` is read as UTC midnight,
 * which shows the previous day west of UTC, and a bare time is not a
 * date at all. So each kind is parsed on its own, in local time.
 * Anything that does not parse is returned as typed rather than blank.
 */
export function formatTemporalAnswer(
  kind: 'date' | 'time' | 'datetime',
  value: unknown,
  locale: SupportedLocale,
): string {
  const raw = String(value).trim();
  if (kind === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return formatDate(d, locale) || raw;
    }
    return formatDate(raw, locale) || raw;
  }
  if (kind === 'time') {
    const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
    if (!m) return raw;
    const d = new Date(1970, 0, 1, Number(m[1]), Number(m[2]), Number(m[3] ?? 0));
    return formatDateTime(d, locale, { timeStyle: 'short' }) || raw;
  }
  return formatDateTime(raw, locale) || raw;
}

/**
 * Merge a `/users?ids=` answer into the submitter-name cache. Every
 * requested id gets an entry, even when the server returned no row
 * for it (a deleted user, or one in another org). Without that the
 * lookup effect sees the id still missing and asks again forever.
 * A miss is cached as the id itself, which is what the panel shows
 * anyway when no name is known.
 */
export function mergeUserNames(
  prev: Record<string, string>,
  requested: readonly string[],
  rows: ReadonlyArray<{ id: string; fullName: string | null; username: string }>,
): Record<string, string> {
  const next = { ...prev };
  for (const u of rows) {
    next[u.id] = u.fullName?.trim() || u.username;
  }
  for (const id of requested) {
    if (!(id in next)) next[id] = id;
  }
  return next;
}
