// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MapData } from '@gratis-gis/shared-types';

import { printReadItemIds } from './print-read-scope.js';

describe('printReadItemIds', () => {
  it('names the data layers, live and proxied services and clip boundaries, nothing else', () => {
    const map = {
      clipBoundaryId: 'clip-map',
      layers: [
        { source: { kind: 'data-layer', itemId: 'dl-1' } },
        {
          boundaryFilterItemId: 'clip-layer',
          source: { kind: 'data-layer', itemId: 'dl-2', layerKey: 'parcels' },
        },
        {
          source: {
            kind: 'arcgis-rest',
            url: 'https://example.test/arcgis/rest/services/x/MapServer',
            layerId: 0,
            serviceType: 'MapServer',
            proxyUrl: '/api/portal/items/svc-1/proxy',
          },
        },
        // A raw ArcGIS URL is fetched directly, so it needs no id.
        {
          source: {
            kind: 'arcgis-rest',
            url: 'https://example.test/arcgis/rest/services/y/MapServer',
            layerId: 1,
            serviceType: 'MapServer',
            sourceItemId: 'svc-raw',
          },
        },
        { source: { kind: 'postgis-live', serviceItemId: 'pg-1', tableName: 't' } },
      ],
    } as unknown as MapData;
    expect(printReadItemIds(map).sort()).toEqual(
      ['clip-layer', 'clip-map', 'dl-1', 'dl-2', 'pg-1', 'svc-1'].sort(),
    );
  });

  it('is empty for no map', () => {
    expect(printReadItemIds(null)).toEqual([]);
  });
});
