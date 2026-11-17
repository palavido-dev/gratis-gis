// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MapData } from '@gratis-gis/shared-types';

const PROXY_URL = /^\/api\/portal\/items\/([^/?#]+)\/proxy(?:[/?#]|$)/;

/**
 * Item ids the print snapshot of `map` fetches layer data for: data
 * layers, postgis-live services, the service items behind proxied
 * ArcGIS layers, and the boundary items a layer or the map clips to.
 * These are the only ids the job's print read credential names.
 * Nothing here grants access: every read still checks the item
 * against the user.
 */
export function printReadItemIds(map: MapData | null | undefined): string[] {
  const ids = new Set<string>();
  if (map?.clipBoundaryId) ids.add(map.clipBoundaryId);
  for (const layer of map?.layers ?? []) {
    if (layer.boundaryFilterItemId) ids.add(layer.boundaryFilterItemId);
    const src = layer.source;
    if (src.kind === 'data-layer') {
      ids.add(src.itemId);
    } else if (src.kind === 'postgis-live') {
      ids.add(src.serviceItemId);
    } else if (src.kind === 'arcgis-rest' && src.proxyUrl) {
      const m = PROXY_URL.exec(src.proxyUrl);
      if (m?.[1]) ids.add(decodeURIComponent(m[1]));
    }
  }
  return Array.from(ids);
}
