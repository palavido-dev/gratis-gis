// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  keywordsFromTags,
  themesFromTags,
} from '@gratis-gis/shared-types';

import { parseBbox, type ItemRow } from './records-core.js';

/**
 * Pure Aardvark / OpenGeoMetadata document builder (#116).
 * Kept free of Nest so unit tests do not pull ESM @nestjs/common.
 */

export type AardvarkItemRow = ItemRow & {
  org?: { name: string } | null;
};

export function buildAardvark(
  row: AardvarkItemRow,
  base: string,
): Record<string, unknown> {
  const themes = themesFromTags(row.tags);
  const keywords = keywordsFromTags(row.tags);
  const bbox = parseBbox(row.bbox);
  const references: Record<string, string> = {
    'http://schema.org/url': `${base}/items/${row.id}`,
  };
  if (row.type === 'data_layer') {
    references['http://www.opengis.net/def/rel/ogc/1.0/features'] =
      `${base}/api/public/ogc/collections/${row.id}/items`;
    // Aardvark has no OGC API Features URI in its vocabulary yet;
    // downloadUrl still lets GeoBlacklight offer a GeoJSON fetch
    // via the public Features items path.
    references['http://schema.org/downloadUrl'] =
      `${base}/api/public/ogc/collections/${row.id}/items?f=json`;
  }

  const out: Record<string, unknown> = {
    dct_title_s: row.title,
    dct_description_sm: [row.description || row.title],
    dct_identifier_s: row.id,
    dct_accessRights_s: 'Public',
    gbl_mdVersion_s: 'Aardvark',
    gbl_resourceClass_sm: resourceClassFor(row.type),
    dct_references_s: JSON.stringify(references),
    schema_provider_s: row.org?.name ?? 'GratisGIS',
    dct_issued_s: row.createdAt.toISOString().slice(0, 10),
  };
  if (themes.length > 0) out.dcat_theme_sm = themes;
  if (keywords.length > 0) out.dcat_keyword_sm = keywords;
  if (row.license) out.dct_license_sm = [row.license];
  if (bbox) {
    const [w, s, e, n] = bbox;
    out.dcat_bbox = `ENVELOPE(${w},${e},${n},${s})`;
    out.dcat_centroid = `${(s + n) / 2},${(w + e) / 2}`;
  }
  return out;
}

/**
 * Collapse GratisGIS item types into Aardvark's seven-value
 * gbl_resourceClass_sm vocabulary. Datasets + Web services cover
 * the bulk of our public catalogue.
 */
export function resourceClassFor(type: string): string[] {
  switch (type) {
    case 'data_layer':
    case 'derived_layer':
    case 'tile_layer':
    case 'point_cloud':
      return ['Datasets'];
    case 'arcgis_service':
    case 'service':
    case 'wms_service':
    case 'wfs_service':
    case 'geocoding_service':
      return ['Web services'];
    case 'map':
    case 'web_app':
    case 'dashboard':
      return ['Maps'];
    case 'file':
      return ['Other'];
    default:
      return ['Other'];
  }
}
