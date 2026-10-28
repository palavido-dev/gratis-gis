// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEARCH_CATALOG_DEFAULT_LIMIT,
  SEARCH_CATALOG_MAX_BBOX_AREA_DEG2,
  SEARCH_CATALOG_MAX_LIMIT,
  buildSearchCatalogPath,
  clientRejectSearchCatalog,
} from './search-catalog.js';

describe('clientRejectSearchCatalog', () => {
  it('accepts q-only search', () => {
    assert.equal(clientRejectSearchCatalog({ q: 'flood' }), null);
  });

  it('accepts a modest bbox', () => {
    assert.equal(
      clientRejectSearchCatalog({
        bbox: [-82, 37.5, -80, 39],
        type: 'data_layer',
      }),
      null,
    );
  });

  it('refuses an oversized bbox', () => {
    const msg = clientRejectSearchCatalog({
      bbox: [-180, -90, 180, 90],
    });
    assert.ok(msg);
    assert.match(msg!, new RegExp(String(SEARCH_CATALOG_MAX_BBOX_AREA_DEG2)));
  });

  it('refuses a degenerate bbox', () => {
    const msg = clientRejectSearchCatalog({
      bbox: [1, 1, 0, 0],
    });
    assert.match(msg ?? '', /degenerate/);
  });

  it('refuses limit above the MCP cap', () => {
    const msg = clientRejectSearchCatalog({
      limit: SEARCH_CATALOG_MAX_LIMIT + 1,
    });
    assert.match(msg ?? '', /limit/);
  });
});

describe('buildSearchCatalogPath', () => {
  it('encodes defaults and q', () => {
    const path = buildSearchCatalogPath({ q: 'parcels' });
    assert.ok(
      path.startsWith('/api/public/ogc/collections/catalog/items?'),
    );
    const qs = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    assert.equal(qs.get('q'), 'parcels');
    assert.equal(qs.get('limit'), String(SEARCH_CATALOG_DEFAULT_LIMIT));
    assert.equal(qs.get('bbox'), null);
  });

  it('encodes type, bbox, offset, and custom limit', () => {
    const path = buildSearchCatalogPath({
      type: 'map',
      bbox: [-81.7, 38.3, -81.5, 38.4],
      limit: 10,
      offset: 20,
    });
    const qs = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    assert.equal(qs.get('type'), 'map');
    assert.equal(qs.get('bbox'), '-81.7,38.3,-81.5,38.4');
    assert.equal(qs.get('limit'), '10');
    assert.equal(qs.get('offset'), '20');
  });
});
