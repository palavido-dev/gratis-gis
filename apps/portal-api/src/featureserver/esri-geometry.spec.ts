// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { geojsonToEsri, parseFilterGeometry } from './esri-geometry.js';

describe('geojsonToEsri', () => {
  it('writes points and lines', () => {
    expect(geojsonToEsri({ type: 'Point', coordinates: [1, 2] }, 'esriGeometryPoint')).toEqual({ x: 1, y: 2 });
    expect(
      geojsonToEsri({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1, 5]]] }, 'esriGeometryPolyline'),
    ).toEqual({ paths: [[[0, 0], [1, 1]]] });
  });

  it('turns outer rings clockwise and holes counterclockwise', () => {
    const outerCcw = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const holeCw = [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]];
    const out = geojsonToEsri({ type: 'Polygon', coordinates: [outerCcw, holeCw] }, 'esriGeometryPolygon') as {
      rings: number[][][];
    };
    expect(out.rings[0]).toEqual([...outerCcw].reverse());
    expect(out.rings[1]).toEqual([...holeCw].reverse());
  });

  it('flattens multipolygons into one ring list', () => {
    const sq = (x: number) => [[x, 0], [x, 1], [x + 1, 1], [x + 1, 0], [x, 0]];
    const out = geojsonToEsri({ type: 'MultiPolygon', coordinates: [[sq(0)], [sq(5)]] }, 'esriGeometryPolygon') as {
      rings: unknown[];
    };
    expect(out.rings).toHaveLength(2);
  });

  it('answers null for a geometry the layer type cannot show', () => {
    expect(geojsonToEsri({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, 'esriGeometryPoint')).toBeNull();
    expect(geojsonToEsri(null, 'esriGeometryPoint')).toBeNull();
  });
});

describe('parseFilterGeometry', () => {
  it('reads an envelope as JSON or as four numbers', () => {
    const a = parseFilterGeometry('{"xmin":3,"ymin":4,"xmax":1,"ymax":2,"spatialReference":{"wkid":102100}}', undefined);
    expect(JSON.parse(a.geojson).coordinates[0][0]).toEqual([1, 2]);
    expect(a.wkid).toBe(102100);
    expect(parseFilterGeometry('-1,-2,3,4', 'esriGeometryEnvelope').rings).toBe(false);
  });

  it('reads polygon rings for ST_BuildArea', () => {
    const g = parseFilterGeometry('{"rings":[[[0,0],[0,1],[1,1],[0,0]]]}', 'esriGeometryPolygon');
    expect(g.rings).toBe(true);
    expect(JSON.parse(g.geojson).type).toBe('MultiLineString');
  });

  it('refuses malformed geometry', () => {
    expect(() => parseFilterGeometry('{"x":"a","y":1}', 'esriGeometryPoint')).toThrow(BadRequestException);
    expect(() => parseFilterGeometry('not json', 'esriGeometryPolygon')).toThrow(BadRequestException);
    expect(() => parseFilterGeometry('{}', 'esriGeometryBag')).toThrow(BadRequestException);
  });
});
