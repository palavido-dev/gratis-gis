// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Narrow a data_layer item's `data` payload to its v3 layer list.
 *
 * ONE implementation. This used to exist as five copies (items,
 * housekeeping, housekeeping-schedule, item-bbox-refresh,
 * search-index), each carrying a comment that it was duplicated to
 * avoid a Nest DI cycle through ItemsService. The cycle was real; the
 * cure was not. A pure function in a leaf module is not a provider and
 * takes part in no injection graph, so every service can import it
 * and nothing is instantiated. What the duplication actually bought
 * was drift: three copies dropped `fields` entirely, two coerced
 * `multi_select` to `string`, one returned `[]` where the others
 * returned `null` for the same input, and only one kept
 * `parentFkColumn`.
 *
 * Semantics, chosen where the copies disagreed:
 *
 *  - `null` for anything that is not a v3 payload (v1/v2 items, or a
 *    payload that is not an object), so callers can skip the v3 path.
 *  - `[]` for a v3 payload whose `layers` is missing or not an array.
 *    It IS a v3 item; it just declares no layers. Every caller
 *    iterates the result, and zero iterations is the right outcome for
 *    both readings, but "v3 with nothing in it" is what the data says.
 *  - `version` must be the number 3. A stringified '3' was accepted by
 *    one copy once and never by the canonical one; rows carrying it
 *    were already invisible to the writer and are not resurrected here.
 *  - Layers without a string id are dropped. Fields without a name are
 *    dropped. An unrecognised field type reads as `string`, which is
 *    what the storage layer does with it too.
 *
 * Keep this the ONLY reader of the v3 layer list. `loadLayerSchema` in
 * features.service.ts reads the full FeatureField objects (domain,
 * storage, nullable) for validation and is the one deliberate
 * exception; it needs more than this shape carries.
 */

import type { FeatureFieldType } from '@gratis-gis/shared-types';
import type { DataLayerLayerShape } from './tables.service.js';

export function readV3Layers(data: unknown): DataLayerLayerShape[] | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { version?: unknown; layers?: unknown };
  if (d.version !== 3) return null;
  if (!Array.isArray(d.layers)) return [];
  return d.layers
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const l = raw as Record<string, unknown>;
      const id = typeof l.id === 'string' ? l.id : '';
      if (!id) return null;
      const gt = l.geometryType;
      const geometryType: DataLayerLayerShape['geometryType'] =
        gt === 'point' || gt === 'line' || gt === 'polygon' ? gt : null;
      const fields: NonNullable<DataLayerLayerShape['fields']> = Array.isArray(
        l.fields,
      )
        ? (l.fields as Array<Record<string, unknown>>)
            .map((f) => {
              const name = typeof f.name === 'string' ? f.name : '';
              const type: FeatureFieldType =
                f.type === 'number' ||
                f.type === 'boolean' ||
                f.type === 'date' ||
                f.type === 'multi_select'
                  ? f.type
                  : 'string';
              return f.searchable === true
                ? { name, type, searchable: true as const }
                : { name, type };
            })
            .filter((f) => f.name.length > 0)
        : [];
      const out: DataLayerLayerShape = { id, geometryType, fields };
      if (typeof l.parentFkColumn === 'string' && l.parentFkColumn.length > 0) {
        out.parentFkColumn = l.parentFkColumn;
      }
      return out;
    })
    .filter((l): l is DataLayerLayerShape => l !== null);
}
