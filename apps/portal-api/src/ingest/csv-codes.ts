// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * True when a digits-only CSV cell is a code, not a quantity: a
 * leading zero on a multi-digit number (ZIP 02134, FIPS 01001) or
 * more digits than a double holds exactly (16+). Typing such a column
 * as a number stored 2134 and 1001 and rounded long ids.
 */
export function isCodeLikeNumber(cell: string): boolean {
  const t = cell.trim();
  const digits = t.startsWith('-') ? t.slice(1) : t;
  const intPart = digits.split('.')[0] ?? '';
  if (intPart.length > 1 && intPart.startsWith('0')) return true;
  return digits.replace('.', '').length > 15;
}
