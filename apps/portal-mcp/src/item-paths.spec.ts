// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildListItemsPath, buildReadLayerPath } from './item-paths.js';

describe('buildListItemsPath', () => {
  it('sends the search term as q, the name GET /api/items reads', () => {
    const url = new URL(`http://x${buildListItemsPath({ query: 'parcels', type: 'data_layer' })}`);
    assert.equal(url.searchParams.get('q'), 'parcels');
    assert.equal(url.searchParams.has('query'), false);
    assert.equal(url.searchParams.get('type'), 'data_layer');
    assert.equal(url.searchParams.get('limit'), '25');
  });
});

describe('buildReadLayerPath', () => {
  it('passes limit to the per-sublayer route', () => {
    assert.equal(
      buildReadLayerPath({ itemId: 'i', layerKey: 'a b', limit: 10 }),
      '/api/items/i/layers/a%20b/geojson?limit=10',
    );
  });

  it('does not pretend the item-level route takes a limit', () => {
    assert.equal(buildReadLayerPath({ itemId: 'i', limit: 10 }), '/api/items/i/geojson');
  });
});
