import type { ItemType } from '@prisma/client';

/**
 * Walks an item's data payload and returns the references it holds to
 * other items. Two kinds of reference exist:
 *
 *   - `itemIds`: direct UUID references (feature-service layers).
 *   - `urls`:    URL references the caller can match against other
 *                items with structured URL data (today: arcgis_service
 *                items whose `data.url` matches).
 *
 * Keeping these separate lets the service build two reverse indexes
 * and match each kind of reference without a schema-wide JSON scan.
 *
 * Today's coverage for map layers (shared-types MapLayerSource):
 *   - source.kind === 'data-layer'  -> itemIds += source.itemId
 *   - source.kind === 'arcgis-rest'      -> urls    += source.url
 *   - source.kind === 'geojson-url'      -> (not tracked; external URL)
 *   - source.kind === 'geojson-inline'   -> (not tracked; inline data)
 *
 * Plus the map's own basemap reference:
 *   - data.basemap (UUID string)         -> itemIds += data.basemap
 *
 * Future candidates as those item types ship:
 *   - dashboard.data.panels[].itemId
 *   - form.data.targetItemId
 *   - report_template.data.sources[].itemId
 *   - web_app.data.mapItemId
 */
export interface Dependencies {
  itemIds: string[];
  urls: string[];
}

export function extractDependencies(
  item: { type: ItemType; data: unknown },
): Dependencies {
  const data = item.data as Record<string, unknown> | null;
  const itemIds = new Set<string>();
  const urls = new Set<string>();
  if (!data) return { itemIds: [], urls: [] };

  if (item.type === 'map') {
    // The map's basemap is a basemap item (since #21 / Phase 1c, the
    // built-ins also live as items), referenced by UUID through
    // `data.basemap`. Record it so the basemap shows up in the map's
    // "Depends on" panel and the map shows up in the basemap's "Used
    // by" panel. The empty-string sentinel from DEFAULT_MAP is
    // intentionally skipped.
    const basemapRef = (data as { basemap?: unknown }).basemap;
    if (typeof basemapRef === 'string' && basemapRef.length > 0) {
      itemIds.add(basemapRef);
    }

    const layers = Array.isArray((data as { layers?: unknown }).layers)
      ? ((data as { layers: unknown[] }).layers as Array<Record<string, unknown>>)
      : [];
    for (const l of layers) {
      const source = l?.source as Record<string, unknown> | undefined;
      if (!source || typeof source !== 'object') continue;
      const kind = source.kind;
      if (kind === 'data-layer') {
        const id = source.itemId;
        if (typeof id === 'string' && id.length > 0) itemIds.add(id);
      } else if (kind === 'arcgis-rest') {
        // Prefer the direct back-reference when the layer was added
        // from a portal item; URL matching is brittle (trailing
        // slashes, alternate hostnames, query strings). Fall back to
        // URL matching for layers added by raw-URL paste.
        const direct = source.sourceItemId;
        if (typeof direct === 'string' && direct.length > 0) {
          itemIds.add(direct);
        }
        const raw = source.url;
        if (typeof raw === 'string' && raw.length > 0) {
          urls.add(normalizeArcgisUrl(raw));
        }
      }
    }
  }

  if (item.type === 'folder') {
    // A folder claims a list of item UUIDs (childItemIds). Each one
    // is a hard dependency: the folder "depends on" the items it
    // contains so that purging an item can cascade-splice the now-
    // gone UUID out of every folder that referenced it. The reverse
    // edge ("Used by: this folder") shows up on each child's detail
    // page so authors can see what folders an item lives in.
    // See docs/folders.md.
    const children = (data as { childItemIds?: unknown }).childItemIds;
    if (Array.isArray(children)) {
      for (const c of children) {
        if (typeof c === 'string' && c.length > 0) itemIds.add(c);
      }
    }
  }

  if (item.type === 'data_layer') {
    // v3 multi-layer: walk each layer's fields and collect pick-list
    // refs (domain type === 'coded-value-ref'). v1/v2 items store
    // `fields` at the top level; handle both shapes.
    const topLevelFields = Array.isArray((data as { fields?: unknown }).fields)
      ? ((data as { fields: unknown[] }).fields as Array<Record<string, unknown>>)
      : [];
    const nestedLayers = Array.isArray((data as { layers?: unknown }).layers)
      ? ((data as { layers: unknown[] }).layers as Array<Record<string, unknown>>)
      : [];
    const fieldSets: Array<Array<Record<string, unknown>>> = [topLevelFields];
    for (const layer of nestedLayers) {
      if (Array.isArray(layer?.fields)) {
        fieldSets.push(
          layer.fields as Array<Record<string, unknown>>,
        );
      }
    }
    for (const fields of fieldSets) {
      for (const f of fields) {
        const domain = f?.domain as Record<string, unknown> | undefined;
        if (!domain) continue;
        if (domain.type === 'coded-value-ref') {
          const pid = domain.pickListItemId;
          if (typeof pid === 'string' && pid.length > 0) itemIds.add(pid);
        }
      }
    }
  }

  // Hook points for other types: extend as those item types come online.

  return { itemIds: Array.from(itemIds), urls: Array.from(urls) };
}

/**
 * Tolerant URL key for matching arcgis-rest layer URLs against
 * arcgis_service item URLs. Strips: surrounding whitespace, query
 * string, fragment, trailing slashes, any trailing `/<digits>` layer
 * index after MapServer/FeatureServer, then lowercases. http/https
 * are collapsed to a schemeless form so a layer URL saved as http and
 * an item URL saved as https still match.
 */
export function normalizeArcgisUrl(u: string): string {
  let s = u.trim();
  // Strip query + fragment: these are presentation artifacts, not
  // part of the service identity.
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  // Collapse scheme so http/https variants match.
  s = s.replace(/^https?:\/\//i, '');
  // Strip trailing slashes (handles both `/` and `///`).
  s = s.replace(/\/+$/, '');
  // Strip a trailing /<layerId> so a layer URL (.../MapServer/2)
  // matches the service root (.../MapServer) the arcgis_service item
  // persists.
  s = s.replace(/\/(MapServer|FeatureServer)\/\d+$/i, '/$1');
  return s.toLowerCase();
}

/** Item types that can reference other items. If we expand this,
 *  update the service's dependents scan to include the new types. */
export const REFERENCER_TYPES: ItemType[] = ['map', 'data_layer', 'folder'];
