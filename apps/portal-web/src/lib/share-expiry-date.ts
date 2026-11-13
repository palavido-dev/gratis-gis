// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Date helpers for the share expiry picker.
 *
 * A date input works in the user's local calendar, and the picker
 * stores a custom pick as local end of day, sent as a UTC ISO string.
 * Reading that string back with `.slice(0, 10)` gave the UTC date:
 * west of UTC an April 30 pick came back as May 1, and each reopen
 * and Set pushed the expiry another day. The `min` attribute had the
 * same problem, so after 5 pm in California today could not be
 * picked. Everything here works on local date parts instead.
 */

/** `YYYY-MM-DD` for the local calendar day of `d`. */
export function localDateInputValue(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The date input value for a stored ISO expiry, or '' when unset. */
export function expiryToDateInput(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : localDateInputValue(d);
}

/**
 * The ISO expiry for a date input value: local end of that day. Null
 * when the input does not parse or the moment has already passed.
 */
export function dateInputToExpiry(
  draft: string,
  now: Date = new Date(),
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) return null;
  const d = new Date(`${draft}T23:59:59`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() <= now.getTime()) return null;
  return d.toISOString();
}
