// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  UNMATCHED_ROUTE,
  methodLabel,
  routeTemplate,
  statusClassLabel,
  tileKindOf,
  tileSurfaceOf,
} from './http-labels';

describe('HTTP metric labels', () => {
  it('keeps methods to a fixed set', () => {
    expect(methodLabel('get')).toBe('GET');
    expect(methodLabel('PROPFIND')).toBe('OTHER');
    expect(methodLabel(undefined)).toBe('OTHER');
  });

  it('reduces status codes to a class', () => {
    expect(statusClassLabel(200)).toBe('2xx');
    expect(statusClassLabel(304)).toBe('3xx');
    expect(statusClassLabel(404)).toBe('4xx');
    expect(statusClassLabel(503)).toBe('5xx');
    expect(statusClassLabel(0)).toBe('unknown');
  });

  it('reads only the matched route template', () => {
    expect(routeTemplate({ route: { path: '/api/items/:id' } })).toBe('/api/items/:id');
    expect(routeTemplate({ route: undefined })).toBe(UNMATCHED_ROUTE);
    // Nest's catch-all not-found route.
    expect(routeTemplate({ route: { path: '*path' } })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ route: { path: '/*path' } })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ route: { path: /x/ } as never })).toBe(UNMATCHED_ROUTE);
  });

  // Every tile route in the API, as Nest registers it with the /api prefix.
  it.each([
    ['/api/items/:id/layers/:layerId/tile/:z/:x/:y.mvt', 'vector', 'portal'],
    ['/api/public/items/:id/layers/:layerId/tile/:z/:x/:y.mvt', 'vector', 'public'],
    [
      '/api/public/ogc/collections/:collectionId/tiles/:tmsId/:tileMatrix/:tileRow/:tileCol',
      'vector',
      'public',
    ],
    ['/api/tile-layer/:itemId/tiles/:z/:x/:y.png', 'raster', 'portal'],
    ['/api/tile-layer/:itemId/tiles/:z/:x/:y', 'raster', 'portal'],
    ['/api/elevation-mosaic/:z/:x/:y.png', 'raster', 'portal'],
  ])('classifies %s as a %s tile', (template, kind, surface) => {
    expect(tileKindOf(template)).toBe(kind);
    expect(tileSurfaceOf(template)).toBe(surface);
  });

  it.each([
    '/api/public/ogc/collections/:collectionId/tiles/:tmsId',
    '/api/tile-layer/:itemId/file.pmtiles',
    '/api/items/:itemId/sam/embedding/:z/:gx/:gy',
    UNMATCHED_ROUTE,
  ])('does not count %s as a tile', (template) => {
    expect(tileKindOf(template)).toBeNull();
  });
});
