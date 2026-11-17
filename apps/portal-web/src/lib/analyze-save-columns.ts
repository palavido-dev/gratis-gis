// SPDX-License-Identifier: AGPL-3.0-or-later
// Column naming for Analyze "Save as layer".
//
// The new layer's schema uses sanitized field names, and the import
// drops every property whose key is not an exact schema field name.
// So the file that is uploaded must carry the sanitized names too,
// or a column such as `count_star()` or "Total" is declared on the
// layer and then loaded as empty. The save flow renames the columns
// inside the COPY with the aliases built here.

/** Field names must satisfy the schema validator ([a-z0-9_], not
 *  starting with a digit). Derived from whatever the user aliased
 *  their result columns to, so normalize hard and keep it stable. */
export function sanitizeFieldName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|(?<!_)_+$/g, '')
    .replace(/^(\d)/, 'f_$1');
  return cleaned.length > 0 ? cleaned : 'field';
}

/**
 * One unique field name per source column, in order. Two columns
 * that sanitize to the same name ("Total" and "total") get a numeric
 * suffix so neither is lost. `reserved` holds names already taken,
 * such as the geometry column's.
 */
export function uniqueFieldNames(
  columns: readonly string[],
  reserved: Iterable<string> = [],
): string[] {
  const taken = new Set<string>(reserved);
  return columns.map((col) => {
    const base = sanitizeFieldName(col);
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
    taken.add(name);
    return name;
  });
}

/** Double-quoted SQL identifier, safe for any column name. */
export function quoteSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
