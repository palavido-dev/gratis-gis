// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The data blob for a "Save as" copy of a map (#797).
 *
 * A copy is a new map owned by the caller, so anything in the source
 * that is about the source's own audience or reviewers does not carry
 * over as-is:
 *
 *   - `layers[].effective` is the server's per-viewer verdict, added on
 *     read by filterMapForViewer. It describes the source's reader, not
 *     the copy, so it is dropped.
 *   - `layers[].access`: a caller who can edit the source read the real
 *     per-layer access entries, and keeping them is what "same map, new
 *     name" means. A caller who could only view it received a policy
 *     with the roster stripped, and a `custom` policy with no entries
 *     hides the layer from everyone except the copy's owner. That is a
 *     broken state nobody chose, so those layers go back to `inherit`.
 *     Inherit widens nothing: the backing item's own sharing still
 *     decides who reads the layer, and the viewer only received layers
 *     whose backing item they can already read.
 *   - `drawings` are other people's redlines on the source. They come
 *     along only when the caller asks, and never with
 *     `anonymousAuthorToken`, which would let whoever holds the cookie
 *     edit the set on the copy too.
 *   - `allowAnonymousDrawings` opens a map to public markup. The copy
 *     starts private and its owner turns that on deliberately if they
 *     want it.
 */
import {
  mapLayerBackingItemId,
  referenceKey,
  withoutReferences,
} from './item-references.js';

export interface MapCopyOptions {
  includeMarkup: boolean;
  /** Whether the caller can edit the source map. */
  sourceEditable: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function copyLayer(
  layer: Record<string, unknown>,
  sourceEditable: boolean,
): Record<string, unknown> {
  const { effective: _effective, ...rest } = layer;
  void _effective;
  if (sourceEditable) return rest;
  const access = isRecord(rest.access) ? rest.access : null;
  if (access?.policy !== 'custom') return rest;
  return { ...rest, access: { policy: 'inherit', entries: [] } };
}

export function mapDataForCopy(
  data: Record<string, unknown>,
  opts: MapCopyOptions,
): Record<string, unknown> {
  const {
    drawings,
    allowAnonymousDrawings: _anon,
    ...rest
  } = data;
  void _anon;
  const out: Record<string, unknown> = { ...rest };
  if (Array.isArray(rest.layers)) {
    out.layers = rest.layers
      .filter(isRecord)
      .map((l) => copyLayer(l, opts.sourceEditable));
  }
  if (opts.includeMarkup && Array.isArray(drawings)) {
    out.drawings = drawings.filter(isRecord).map((set) => {
      const { anonymousAuthorToken: _token, ...kept } = set;
      void _token;
      return kept;
    });
  }
  return out;
}

/**
 * Map data without the references in `drop` (ids the person saving the
 * copy cannot read), for "Save as". A layer that reads through a
 * dropped item, or is clipped or related through one, is left out
 * whole; an ArcGIS layer keeps working from its URL without the item
 * link, as the web map import does. A dropped basemap goes back to the
 * empty value that create() resolves to the org's default basemap.
 * Terrain keeps the stack entries that remain. Anything else that names
 * a dropped id loses that reference.
 */
export function mapDataWithoutReferences(
  data: Record<string, unknown>,
  drop: ReadonlySet<string>,
): Record<string, unknown> {
  if (drop.size === 0) return data;
  const named = (v: unknown): boolean => typeof v === 'string' && drop.has(referenceKey(v));
  const out: Record<string, unknown> = { ...data };
  if (named(out.basemap)) out.basemap = '';
  for (const key of ['defaultExtentBoundaryId', 'clipBoundaryId', 'geocoderId']) {
    if (named(out[key])) delete out[key];
  }
  if (isRecord(out.terrain)) {
    const terrain = { ...out.terrain };
    const stack = Array.isArray(terrain.stack)
      ? terrain.stack.filter((e) => !(isRecord(e) && named(e.itemId)))
      : undefined;
    if (stack !== undefined) terrain.stack = stack;
    if (named(terrain.itemId)) {
      const first = stack?.find(isRecord);
      if (first && typeof first.itemId === 'string') {
        terrain.itemId = first.itemId;
        if (typeof first.tileUrl === 'string') terrain.tileUrl = first.tileUrl;
      } else {
        delete terrain.itemId;
        delete terrain.tileUrl;
      }
    }
    if (typeof terrain.itemId === 'string') out.terrain = terrain;
    else delete out.terrain;
  }
  if (Array.isArray(out.layers)) {
    const kept: unknown[] = [];
    for (const layer of out.layers) {
      if (!isRecord(layer)) {
        kept.push(layer);
        continue;
      }
      const via = isRecord(layer.via) ? layer.via : null;
      if (named(layer.boundaryFilterItemId) || named(via?.parentItemId)) continue;
      const backing = mapLayerBackingItemId(layer);
      if (backing !== null && named(backing)) {
        const source = isRecord(layer.source) ? layer.source : null;
        if (source?.kind !== 'arcgis-rest') continue;
        const { sourceItemId: _dropped, ...rest } = source;
        void _dropped;
        kept.push({ ...layer, source: rest });
        continue;
      }
      kept.push(layer);
    }
    out.layers = kept;
  }
  return withoutReferences(out, drop) as Record<string, unknown>;
}
