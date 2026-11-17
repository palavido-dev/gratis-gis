// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Postgres regex literal used to gate a `properties->>'<field>'` text
 * value before casting it to `double precision`. Accepts a leading
 * sign, integers, leading or trailing decimals (`.5`, `5.`) and
 * scientific notation (`1e3`, `1.5E-2`). Doubled backslashes are JS
 * string escaping; the SQL sees `^-?(...)$` literally.
 *
 * Every tool that reads a number out of the properties blob uses this
 * one rule, so a value like `1e3` counts the same way everywhere and a
 * stray "n/a" becomes NULL instead of failing the whole query.
 */
export const NUMERIC_TEXT_REGEX_LITERAL =
  "'^-?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?$'";

/**
 * SQL for "the numeric value of this text expression, or NULL when it
 * is not a number". `textSql` must be a side-effect-free expression
 * (it is evaluated twice). CASE evaluates the test before the cast, so
 * the cast never sees text that would make it throw.
 */
export function numericTextSql(textSql: string): string {
  return `(CASE WHEN ${textSql} ~ ${NUMERIC_TEXT_REGEX_LITERAL} THEN (${textSql})::double precision END)`;
}
