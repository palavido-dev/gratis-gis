// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Field-name allowlist shared by the expression language, schema
 * ingest and every SQL emitter (SEC-expr-field-allowlist).
 */

/**
 * Field identifiers that are safe to embed as SQL string literals
 * (`properties->>'name'`) without relying on quote-doubling alone.
 * Matches the regex already used for calculate-field output names,
 * contour fields, aggregate groupBy, and parentFk filters.
 *
 * Expression `{{refs}}`, ingest schema keys, and SQL emitters must
 * all agree on this allowlist (SEC-expr-field-allowlist).
 */
export const SQL_SAFE_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Cap shared with Postgres identifier practicality and UI limits. */
export const MAX_SQL_SAFE_FIELD_NAME_LENGTH = 63;

const RESERVED_SQL_SAFE_FIELD_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** True when `name` may be embedded in SQL / used as a schema key. */
export function isSqlSafeFieldName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_SQL_SAFE_FIELD_NAME_LENGTH &&
    SQL_SAFE_FIELD_NAME_RE.test(name) &&
    !RESERVED_SQL_SAFE_FIELD_NAMES.has(name.toLowerCase())
  );
}

/**
 * Map an arbitrary CSV / GDAL header to an allowlisted identifier.
 * Identity-preserving when already safe. Collision-aware when the
 * caller passes a `used` set (mutated). Original display text belongs
 * on FeatureField.label, not on `name`.
 */
export function toSqlSafeFieldName(raw: string, used?: Set<string>): string {
  const trimmed = raw.trim();
  let base: string;
  if (isSqlSafeFieldName(trimmed)) {
    base = trimmed;
  } else {
    // Character walk (no regex) so CodeQL does not flag ReDoS on
    // pathological underscore runs from a crafted CSV header.
    let slug = '';
    let lastUnderscore = false;
    for (let i = 0; i < trimmed.length; i += 1) {
      const code = trimmed.charCodeAt(i);
      const isAz =
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      const isDigit = code >= 48 && code <= 57;
      const isUnderscore = code === 95;
      if (isAz || isDigit || isUnderscore) {
        slug += trimmed[i]!;
        lastUnderscore = isUnderscore;
      } else if (slug.length > 0 && !lastUnderscore) {
        slug += '_';
        lastUnderscore = true;
      }
    }
    if (slug.endsWith('_')) slug = slug.slice(0, -1);
    base = slug;
    if (!base || (base.charCodeAt(0) >= 48 && base.charCodeAt(0) <= 57)) {
      base = `f_${base || 'field'}`;
    }
    // A reserved word gets the prefix here. Checked after the safety
    // test it never ran: a reserved name already fails that test and
    // became plain "field".
    if (RESERVED_SQL_SAFE_FIELD_NAMES.has(base.toLowerCase())) {
      base = `f_${base}`;
    }
    if (base.length > MAX_SQL_SAFE_FIELD_NAME_LENGTH) {
      base = base.slice(0, MAX_SQL_SAFE_FIELD_NAME_LENGTH);
    }
    if (!isSqlSafeFieldName(base)) {
      base = 'field';
    }
  }
  if (!used) return base;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = `_${n}`;
    candidate =
      base.slice(0, MAX_SQL_SAFE_FIELD_NAME_LENGTH - suffix.length) + suffix;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}
