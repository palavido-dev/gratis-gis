// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField } from '@gratis-gis/shared-types';

/**
 * Columns for exporting a layer with no declared fields (2026-11
 * review, 06-16). Such a layer stays writable on purpose, but the CSV
 * and GeoParquet exports took their columns from the declared schema
 * only, so they wrote geometry and nothing else. This walks the rows
 * once and returns every property key in first-seen order.
 *
 * A column is typed number or boolean only when every non-null value
 * in it is one; anything else is text, which keeps every value.
 */

/** Columns past this many are left out, so one odd layer cannot make
 *  a file with tens of thousands of columns. */
export const MAX_DERIVED_EXPORT_COLUMNS = 1000;

type Seen = 'number' | 'boolean' | 'string' | null;

export async function deriveExportFields(
  batches: AsyncIterable<Array<{ properties?: unknown }>>,
): Promise<FeatureField[]> {
  const kinds = new Map<string, Seen>();
  for await (const batch of batches) {
    for (const feature of batch) {
      const props = feature.properties;
      if (!props || typeof props !== 'object') continue;
      for (const [key, value] of Object.entries(
        props as Record<string, unknown>,
      )) {
        if (!kinds.has(key)) {
          if (kinds.size >= MAX_DERIVED_EXPORT_COLUMNS) continue;
          kinds.set(key, null);
        }
        if (value === null || value === undefined) continue;
        const now = kinds.get(key) ?? null;
        const kind: Seen =
          typeof value === 'number'
            ? 'number'
            : typeof value === 'boolean'
              ? 'boolean'
              : 'string';
        if (now === null) kinds.set(key, kind);
        else if (now !== kind) kinds.set(key, 'string');
      }
    }
  }
  return [...kinds].map(([name, kind]) => ({
    name,
    label: name,
    type: kind ?? 'string',
  })) as FeatureField[];
}
