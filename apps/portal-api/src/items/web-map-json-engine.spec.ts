// SPDX-License-Identifier: AGPL-3.0-or-later
import { cellForGeometry, lensesToWebMapJson, webMapJsonToLenses } from '@gratis-gis/engine';

/**
 * The engine package has no test harness of its own, so its WebMap
 * and cell helpers are checked here, where they are used.
 */
describe('WebMap import and export (engine)', () => {
  it('fits an extent-only viewpoint instead of opening at zoom 0', () => {
    const out = webMapJsonToLenses({
      version: '2.32',
      operationalLayers: [],
      initialState: {
        viewpoint: {
          targetGeometry: {
            xmin: -9.1e6,
            ymin: 4.6e6,
            xmax: -8.9e6,
            ymax: 4.8e6,
            spatialReference: { wkid: 102100 },
          },
        },
      },
    } as never);
    expect(out.view?.zoom).toBeGreaterThan(6);
  });

  it('converts scale to MapLibre zoom one below the Esri level', () => {
    const out = webMapJsonToLenses({
      version: '2.32',
      operationalLayers: [],
      initialState: {
        viewpoint: {
          targetGeometry: { xmin: 0, ymin: 0, xmax: 0, ymax: 0 },
          scale: 591657550.5 / 2 ** 10,
        },
      },
    } as never);
    expect(out.view?.zoom).toBeCloseTo(9);
  });

  it('skips a layer whose url is not a string instead of throwing', () => {
    const out = webMapJsonToLenses({
      version: '2.32',
      operationalLayers: [{ layerType: 'ArcGISFeatureLayer', url: 123, title: { a: 1 } }],
    } as never);
    expect(out.lenses).toHaveLength(0);
    expect(out.warnings.join(' ')).toMatch(/not a string/);
  });

  it('exports the basemap with a spec templateUrl', () => {
    const doc = lensesToWebMapJson({ lenses: [] } as never, {
      basemap: { id: 'b', title: 'B', tileUrl: 'https://t.example/{z}/{x}/{y}.png' },
    } as never);
    expect(doc.baseMap.baseMapLayers[0]?.['templateUrl']).toBe(
      'https://t.example/{level}/{col}/{row}.png',
    );
  });
});

describe('cellForGeometry (engine)', () => {
  it('returns null for malformed geometry instead of throwing', () => {
    expect(cellForGeometry({ type: 'Point' } as never)).toBeNull();
    expect(cellForGeometry({ type: 'LineString' } as never)).toBeNull();
    expect(cellForGeometry({ type: 'Point', coordinates: [] } as never)).toBeNull();
    expect(cellForGeometry({ type: 'Point', coordinates: [10, 20] } as never)).toMatch(/^[0-9a-f]+$/);
  });
});
