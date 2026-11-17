// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps a v3 data layer draft in step with the server copy.
//
// The detail page edits a draft of the item's `data` blob. Imports,
// row edits and conflict handling change parts of that blob on the
// server (row counts, extents, provenance, sync conflicts) while the
// page is open. A draft that never takes those in shows old counts,
// and "Save schema" then writes the old values back over the new
// ones. These fields are written by the server, never by the schema
// builder, so the server copy always wins for them.

import type {
  DataLayerDataV3,
  DataLayerSublayer,
} from '@gratis-gis/shared-types';

/** Sublayer fields owned by the server, never edited in the builder. */
export const SERVER_OWNED_LAYER_KEYS = [
  'featureCount',
  'bbox',
  'updatedAt',
  'syncVersion',
  'syncConflicts',
  'source',
] as const satisfies ReadonlyArray<keyof DataLayerSublayer>;

/**
 * The draft with every server-owned field taken from `server`, layer
 * by layer (matched on id). Layers only in the draft (added and not
 * saved yet) are left alone. A key the server copy does not have is
 * removed from the draft layer, so a cleared conflict list stays
 * cleared. Returns the draft itself when nothing differs, so a
 * caller can skip a state update.
 */
export function withServerOwnedFields(
  draft: DataLayerDataV3,
  server: DataLayerDataV3,
): DataLayerDataV3 {
  const byId = new Map(server.layers.map((l) => [l.id, l]));
  let changed = false;
  const layers = draft.layers.map((layer) => {
    const live = byId.get(layer.id);
    if (!live) return layer;
    let next: DataLayerSublayer = layer;
    for (const key of SERVER_OWNED_LAYER_KEYS) {
      if (layer[key] === live[key]) continue;
      if (next === layer) next = { ...layer };
      if (live[key] === undefined) {
        delete next[key];
      } else {
        (next as unknown as Record<string, unknown>)[key] = live[key];
      }
    }
    if (next !== layer) changed = true;
    return next;
  });
  return changed ? { ...draft, layers } : draft;
}
