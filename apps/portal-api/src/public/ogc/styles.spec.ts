// SPDX-License-Identifier: AGPL-3.0-or-later
import { buildMapLibreStyle } from './styles.controller.js';

/**
 * The default style used to draw from the items URL, which returns
 * one 100-feature page; a MapLibre geojson source never follows next
 * links. It now draws from the collection's vector tiles.
 */
function row(geometryType: 'Polygon' | null) {
  return {
    styleId: 'abc',
    itemId: 'abc',
    layerKey: null,
    geometryType,
    title: 'Parcels',
    description: '',
    tags: [],
    license: null,
  };
}

describe('buildMapLibreStyle', () => {
  it('draws a spatial layer from the vector tileset', () => {
    const style = buildMapLibreStyle(row('Polygon'), 'https://p') as {
      sources: { data: { type: string; url?: string } };
      layers: Array<{ 'source-layer'?: string }>;
    };
    expect(style.sources.data).toEqual({
      type: 'vector',
      url: 'https://p/api/public/ogc/collections/abc/tiles/WebMercatorQuad/tilejson.json',
    });
    expect(style.layers.length).toBeGreaterThan(0);
    for (const l of style.layers) expect(l['source-layer']).toBe('features');
  });

  it('keeps a table on the items URL with no paint layers', () => {
    const style = buildMapLibreStyle(row(null), 'https://p') as {
      sources: { data: { type: string } };
      layers: unknown[];
    };
    expect(style.sources.data.type).toBe('geojson');
    expect(style.layers).toEqual([]);
  });
});
