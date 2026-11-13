// SPDX-License-Identifier: AGPL-3.0-or-later
import { bboxWriteForData, itemBbox, searchEnvelopes } from './item-bbox.js';

/**
 * The cached-extent rules, per item type.
 *
 * tile_layer and point_cloud are the reason this spec exists: both
 * types computed an extent at finalize and stored it in data_json,
 * but the switch here had no case for them, so item.bbox stayed
 * empty for every raster and point cloud ever uploaded. Nothing
 * failed loudly; geographic search just never matched them and STAC
 * items could not be built. A missing case in this switch is exactly
 * the kind of gap a test names.
 */

const BBOX: [number, number, number, number] = [-79.98, 38.61, -79.62, 38.94];

describe('itemBbox per-type sources', () => {
  it('reads a tile_layer extent from data.bbox', () => {
    expect(itemBbox('tile_layer', { version: 1, bbox: BBOX })).toEqual(BBOX);
  });

  it('reads a point_cloud extent from data.bboxWgs84, not data.bbox', () => {
    // The native bounds live in the file's own CRS; only the
    // reprojected copy may become the cached EPSG:4326 extent.
    expect(itemBbox('point_cloud', { bboxWgs84: BBOX })).toEqual(BBOX);
    expect(itemBbox('point_cloud', { bbox: BBOX })).toBeNull();
  });

  it('a tile_layer still uploading has no extent yet', () => {
    expect(
      itemBbox('tile_layer', { version: 1, processingState: 'uploading' }),
    ).toBeNull();
  });

  it('refuses a malformed bbox rather than caching garbage', () => {
    expect(itemBbox('tile_layer', { bbox: [1, 2, 3] })).toBeNull();
    expect(itemBbox('tile_layer', { bbox: ['w', 's', 'e', 'n'] })).toBeNull();
    expect(itemBbox('tile_layer', { bbox: [1, 2, 3, Infinity] })).toBeNull();
  });

  it('data_layer keeps its existing source', () => {
    expect(itemBbox('data_layer', { bbox: BBOX })).toEqual(BBOX);
  });

  it('types without a spatial footprint still answer null', () => {
    expect(itemBbox('folder', { bbox: BBOX })).toBeNull();
    expect(itemBbox('form', { bbox: BBOX })).toBeNull();
  });
});

// A v3 data layer or a map carries no extent in its blob, so writing
// itemBbox's null as [] on every save blanked a good stored extent.
describe('bboxWriteForData', () => {
  it('leaves the column alone for a v3 data layer blob', () => {
    expect(
      bboxWriteForData('data_layer', { version: 3, layers: [{ id: 'L1' }] }),
    ).toEqual({});
  });

  it('leaves the column alone for a map blob', () => {
    expect(
      bboxWriteForData('map', { layers: [{ kind: 'data-layer', itemId: 'x' }] }),
    ).toEqual({});
  });

  it('still writes an extent the blob does carry', () => {
    expect(bboxWriteForData('data_layer', { bbox: [0, 0, 1, 1] })).toEqual({
      bbox: [0, 0, 1, 1],
    });
  });

  it('clears the column for a type whose extent lives in the blob', () => {
    expect(bboxWriteForData('geo_boundary', {})).toEqual({ bbox: [] });
  });
});

describe('searchEnvelopes', () => {
  it('passes an ordinary box through', () => {
    expect(searchEnvelopes([-120, 30, -110, 40], 0)).toEqual([[-120, 30, -110, 40]]);
  });

  it('splits a box that crosses the antimeridian', () => {
    expect(searchEnvelopes([170, -20, 190, -10], 0)).toEqual([
      [170, -20, 180, -10],
      [-180, -20, -170, -10],
    ]);
  });

  it('wraps a box framed entirely past 180', () => {
    expect(searchEnvelopes([185, 0, 190, 5], 0)).toEqual([[-175, 0, -170, 5]]);
  });

  it('becomes the whole world for a full turn or more, clamping latitude', () => {
    expect(searchEnvelopes([-200, -95, 200, 95], 1)).toEqual([[-180, -90, 180, 90]]);
  });
});
