// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DEFAULT_SOURCE_ZOOM,
  dataLayerKeepKey,
  dataLayerSourceZoom,
  dataLayerVectorSource,
  ensureSourceZooms,
  resetSourceZoomCache,
  tileJsonSourceZoom,
} from './tile-zoom';

/**
 * The web map's vector source must carry the layer's tile zoom range.
 * Without it the source keeps maxzoom 22, MapLibre asks for tiles past
 * the layer's maxZoom, the server answers them empty, and a layer whose
 * owner set maxZoom 14 vanishes at z15.
 */
describe('data layer source zoom', () => {
  beforeEach(() => resetSourceZoomCache());

  const flush = () => new Promise((r) => setTimeout(r, 0));

  function fakeFetch(body: unknown, ok = true) {
    return jest.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  }

  it('defaults to the historical range before anything is known', () => {
    const src = dataLayerVectorSource('/t/{z}/{x}/{y}.mvt', dataLayerSourceZoom({ itemId: 'i', layerKey: 'a' }));
    expect(src).toMatchObject({ minzoom: 0, maxzoom: 22, tiles: ['/t/{z}/{x}/{y}.mvt'] });
  });

  it('takes the range from the layer TileJSON so MapLibre overzooms past maxZoom', async () => {
    const fetchImpl = fakeFetch({ minzoom: 6, maxzoom: 14 });
    const onChange = jest.fn();
    ensureSourceZooms([{ itemId: 'i', layerKey: 'a' }], onChange, fetchImpl);
    await flush();
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith('/api/portal/items/i/layers/a/tilejson.json');
    expect(onChange).toHaveBeenCalledTimes(1);
    const src = dataLayerVectorSource('u', dataLayerSourceZoom({ itemId: 'i', layerKey: 'a' }));
    expect(src.minzoom).toBe(6);
    expect(src.maxzoom).toBe(14);
    // Asked again: cached, no second fetch.
    ensureSourceZooms([{ itemId: 'i', layerKey: 'a' }], onChange, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the default, without a rebuild, when the TileJSON is denied or default', async () => {
    const onChange = jest.fn();
    ensureSourceZooms([{ itemId: 'i', layerKey: 'a' }], onChange, fakeFetch({}, false));
    ensureSourceZooms([{ itemId: 'i', layerKey: 'b' }], onChange, fakeFetch({ minzoom: 0, maxzoom: 22 }));
    await flush();
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(dataLayerSourceZoom({ itemId: 'i', layerKey: 'a' })).toEqual(DEFAULT_SOURCE_ZOOM);
  });

  it('reads TileJSON zooms defensively', () => {
    expect(tileJsonSourceZoom({ minzoom: 3, maxzoom: 30 })).toEqual({ minzoom: 3, maxzoom: 24 });
    expect(tileJsonSourceZoom({ minzoom: 'x' })).toEqual(DEFAULT_SOURCE_ZOOM);
    expect(tileJsonSourceZoom({ minzoom: 12, maxzoom: 4 })).toEqual(DEFAULT_SOURCE_ZOOM);
  });

  it('changes the keep-alive key when the range changes, so the source is rebuilt', () => {
    expect(dataLayerKeepKey('u', { minzoom: 0, maxzoom: 22 })).not.toBe(
      dataLayerKeepKey('u', { minzoom: 0, maxzoom: 14 }),
    );
  });
});
