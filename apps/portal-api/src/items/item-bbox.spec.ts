// SPDX-License-Identifier: AGPL-3.0-or-later
import { itemBbox } from './item-bbox.js';

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
