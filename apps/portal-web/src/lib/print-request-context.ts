// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The requester's time zone and locale for a server-side PDF.
 *
 * The PDF renders on the server, whose clock is UTC, so a user in
 * California printing in the afternoon got tomorrow's date. The print
 * request now carries the browser's zone and locale through the
 * preview URL. Both arrive as untrusted query text, so each is only
 * used when it names a zone Intl knows or a locale the portal ships.
 */
import { DEFAULT_LOCALE, LOCALES, type SupportedLocale } from './i18n/locales';

export function printTimeZone(raw: string | undefined | null): string | null {
  if (!raw || raw.length > 64) return null;
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat('en', { timeZone: raw });
    return raw;
  } catch {
    return null;
  }
}

export function printLocale(raw: string | undefined | null): SupportedLocale {
  const match = LOCALES.find((l) => l.code === raw);
  return match ? match.code : DEFAULT_LOCALE;
}
