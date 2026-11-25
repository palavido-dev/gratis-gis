// SPDX-License-Identifier: AGPL-3.0-or-later
import { EditError, editList, esriToGeojson, fromEsriAttributes, geometryWkid } from './esri-edit.js';
import { esriSchema } from './esri-fields.js';

const schema = esriSchema([
  { name: 'name', type: 'string' },
  { name: 'n', type: 'number' },
  { name: 'wet', type: 'boolean' },
  { name: 'seen', type: 'date' },
  { name: 'tags', type: 'multi_select' },
]);

describe('esriToGeojson', () => {
  it('reads points, lines and multipoints', () => {
    expect(esriToGeojson({ x: 1, y: 2, z: 9 }, 'esriGeometryPoint')).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(esriToGeojson({ paths: [[[0, 0], [1, 1]]] }, 'esriGeometryPolyline')).toEqual({
      type: 'LineString',
      coordinates: [[0, 0], [1, 1]],
    });
    expect(esriToGeojson({ points: [[0, 0], [1, 1]] }, 'esriGeometryMultipoint')).toMatchObject({ type: 'MultiPoint' });
    expect(esriToGeojson(null, 'esriGeometryPoint')).toBeNull();
    expect(esriToGeojson({ x: NaN, y: NaN }, 'esriGeometryPoint')).toBeNull();
  });

  it('gives each hole to the outer ring around it', () => {
    const cw = (x: number, s: number) => [[x, 0], [x, s], [x + s, s], [x + s, 0], [x, 0]];
    const ccw = (x: number, s: number) => [...cw(x, s)].reverse();
    const g = esriToGeojson({ rings: [cw(0, 10), cw(20, 10), ccw(22, 2)] }, 'esriGeometryPolygon') as {
      type: string;
      coordinates: number[][][][];
    };
    expect(g.type).toBe('MultiPolygon');
    expect(g.coordinates[0]).toHaveLength(1);
    expect(g.coordinates[1]).toHaveLength(2);
    // GeoJSON winding: outer counterclockwise.
    expect(g.coordinates[0]![0]).toEqual(ccw(0, 10));
  });

  it('closes an open ring and reads all-counterclockwise rings as outer rings', () => {
    const g = esriToGeojson({ rings: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, 'esriGeometryPolygon') as {
      type: string;
      coordinates: number[][][];
    };
    expect(g.type).toBe('Polygon');
    expect(g.coordinates[0]).toHaveLength(5);
  });

  it('refuses curves and junk', () => {
    expect(() => esriToGeojson({ curveRings: [] }, 'esriGeometryPolygon')).toThrow(EditError);
    expect(() => esriToGeojson({ x: 'a', y: 1 }, 'esriGeometryPoint')).toThrow(EditError);
    expect(() => esriToGeojson({ rings: [[[0, 0], [1, 1]]] }, 'esriGeometryPolygon')).toThrow(EditError);
  });
});

describe('fromEsriAttributes', () => {
  it('converts to stored values and skips the server fields', () => {
    expect(
      fromEsriAttributes(schema, {
        OBJECTID: 4,
        globalid: '{X}',
        NAME: 7,
        n: '2.5',
        wet: 1,
        seen: Date.UTC(2026, 0, 2),
        tags: 'a, b,',
      }),
    ).toEqual({ name: '7', n: 2.5, wet: true, seen: '2026-01-02T00:00:00.000Z', tags: ['a', 'b'] });
    expect(fromEsriAttributes(schema, { n: null })).toEqual({ n: null });
  });

  it('refuses unknown fields and bad values', () => {
    expect(() => fromEsriAttributes(schema, { nope: 1 })).toThrow(/no field named "nope"/);
    expect(() => fromEsriAttributes(schema, { n: 'x' })).toThrow(EditError);
    expect(() => fromEsriAttributes(schema, { wet: 2 })).toThrow(EditError);
  });
});

describe('helpers', () => {
  it('reads wkids and edit lists', () => {
    expect(geometryWkid({ x: 1, y: 1, spatialReference: { wkid: 102100 } })).toBe(3857);
    expect(geometryWkid({ x: 1, y: 1 })).toBeNull();
    expect(editList('[1,2]', 'deletes')).toEqual([1, 2]);
    expect(editList(undefined, 'adds')).toEqual([]);
    expect(() => editList('{', 'adds')).toThrow(EditError);
  });
});
