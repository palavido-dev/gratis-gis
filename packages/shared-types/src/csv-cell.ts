// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One CSV cell, RFC 4180 quoted, safe to open in a spreadsheet.
 *
 * A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage
 * return is read as a formula by Excel, LibreOffice and Sheets. Layer
 * exports carry text typed by anyone who can submit to a form (public
 * forms included), so `=HYPERLINK(...)` in an answer would run in the
 * owner's spreadsheet. Such a cell gets a leading `'`, which the
 * spreadsheet shows as text. Only strings are guarded: a number such
 * as -5 is written as is so it stays numeric.
 */
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && FORMULA.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
