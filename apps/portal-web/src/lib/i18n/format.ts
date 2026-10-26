// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 3: locale-aware number / date / relative-time helpers.
 *
 * Call sites used to construct `new Intl.NumberFormat(undefined, …)`
 * and friends, which always followed the browser default rather than
 * the portal's negotiated locale. These helpers take an explicit
 * `SupportedLocale` (or bind one via `useFormat()`) so a Spanish
 * viewer sees `1.234,5` and a relative "hace 3 días" even when their
 * browser UI language is English.
 *
 * Coordinate / unit-system formatting (metric vs imperial) stays out
 * of scope here — that needs a separate prefs surface.
 */
import { useMemo } from 'react';

import type { SupportedLocale } from './locales';
import { useLocale } from './locale-context';

export function formatNumber(
  value: number,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(
  value: string | number | Date,
  locale: SupportedLocale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(
    locale,
    options ?? { dateStyle: 'medium' },
  ).format(date);
}

export function formatDateTime(
  value: string | number | Date,
  locale: SupportedLocale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(
    locale,
    options ?? { dateStyle: 'medium', timeStyle: 'short' },
  ).format(date);
}

export function formatRelativeTime(
  value: string | number | Date,
  locale: SupportedLocale,
): string {
  const then = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return fmt.format(Math.round(seconds / size), unit);
    }
  }
  return fmt.format(seconds, 'second');
}

/** Bound formatters for the active locale from context. */
export function useFormat(): {
  locale: SupportedLocale;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  date: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  dateTime: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  relativeTime: (value: string | number | Date) => string;
} {
  const locale = useLocale();
  return useMemo(
    () => ({
      locale,
      number: (value, options) => formatNumber(value, locale, options),
      date: (value, options) => formatDate(value, locale, options),
      dateTime: (value, options) => formatDateTime(value, locale, options),
      relativeTime: (value) => formatRelativeTime(value, locale),
    }),
    [locale],
  );
}
