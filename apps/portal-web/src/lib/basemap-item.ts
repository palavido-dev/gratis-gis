// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BasemapData, Item } from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';

/**
 * Map a basemap item (type=basemap, data_json: BasemapData) into the
 * CustomBasemap row shape MapEditor / MapCanvas consume. Returns
 * null when the basemap isn't renderable yet: unset URL, unknown
 * kind, or a Phase 2 `composed-map` kind the canvas doesn't handle.
 *
 * Server-safe module: type-only imports, no maplibre. The item
 * detail page, field page, and custom-run page carry older inline
 * copies of this converter; new callers should import from here
 * (consolidating the older copies is tracked cleanup).
 */
export function basemapItemToCustomBasemap(
  it: Item<BasemapData>,
): CustomBasemap | null {
  const d = it.data ?? ({} as BasemapData);
  let url: string | undefined;
  let sourceKind: CustomBasemap['sourceKind'];
  let config: Record<string, unknown> | null = null;
  switch (d.kind) {
    case 'style-url':
      if (!d.styleUrl) return null;
      url = d.styleUrl;
      sourceKind = 'vector-style';
      break;
    case 'tile-url':
      if (!d.tileUrl) return null;
      url = d.tileUrl;
      sourceKind = 'xyz';
      break;
    case 'wms':
      if (!d.wmsUrl) return null;
      url = d.wmsUrl;
      sourceKind = 'wms';
      config = (d.wmsConfig ?? null) as Record<string, unknown> | null;
      break;
    default:
      return null;
  }
  return {
    id: it.id,
    orgId: it.orgId,
    label: it.title,
    description: it.description ?? '',
    url,
    sourceKind,
    attribution: d.attribution ?? '',
    thumbnailUrl: d.thumbnailUrl ?? it.thumbnailUrl ?? null,
    config,
    isDefault: false,
  };
}
