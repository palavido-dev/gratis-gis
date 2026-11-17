// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { spatialFilterGenerator } from './spatial-filter.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
  { name: 'acres', label: 'Acres', type: 'number', nullable: true },
];

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

describe('spatialFilterGenerator.validate', () => {
  it('accepts a data_layer reference with intersects predicate', () => {
    const out = spatialFilterGenerator.validate({
      otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
      predicate: 'intersects',
    });
    expect(out.otherSource.kind).toBe('data_layer');
    expect(out.predicate).toBe('intersects');
    expect(out.distanceMeters).toBeUndefined();
  });

  it('accepts a PredicateRef discriminator shape from the recipe runner', () => {
    const out = spatialFilterGenerator.validate({
      otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
      predicate: { kind: 'fixed', value: 'within' },
    });
    expect(out.predicate).toBe('within');
  });

  it('requires distance when predicate is near', () => {
    expect(() =>
      spatialFilterGenerator.validate({
        otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
        predicate: 'near',
      }),
    ).toThrow(BadRequestException);
  });

  it('accepts a near predicate with meters distance', () => {
    const out = spatialFilterGenerator.validate({
      otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
      predicate: 'near',
      distance: 250,
    });
    expect(out.predicate).toBe('near');
    expect(out.distanceMeters).toBe(250);
  });

  it('accepts a DistanceRef discriminator shape', () => {
    const out = spatialFilterGenerator.validate({
      otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
      predicate: 'near',
      distance: { kind: 'fixed', meters: 1000 },
    });
    expect(out.distanceMeters).toBe(1000);
  });

  it('rejects negative or absurdly large distance', () => {
    expect(() =>
      spatialFilterGenerator.validate({
        otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
        predicate: 'near',
        distance: -5,
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      spatialFilterGenerator.validate({
        otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
        predicate: 'near',
        distance: 5_000_000,
      }),
    ).toThrow(BadRequestException);
  });

  it('accepts an inline-geometry otherSource', () => {
    const out = spatialFilterGenerator.validate({
      otherSource: {
        kind: 'inline-geometry',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      },
      predicate: 'intersects',
    });
    expect(out.otherSource.kind).toBe('inline-geometry');
  });

  it('rejects an unresolved parameter reference on otherSource', () => {
    expect(() =>
      spatialFilterGenerator.validate({
        otherSource: { kind: 'parameter', name: 'aoi' },
        predicate: 'intersects',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects an unresolved parameter reference on predicate', () => {
    expect(() =>
      spatialFilterGenerator.validate({
        otherSource: { kind: 'data_layer', itemId: 'p' },
        predicate: { kind: 'parameter', name: 'pred' },
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects unknown predicate names', () => {
    expect(() =>
      spatialFilterGenerator.validate({
        otherSource: { kind: 'data_layer', itemId: 'p' },
        predicate: 'overlaps',
      }),
    ).toThrow(BadRequestException);
  });
});

describe('spatialFilterGenerator.outputSchema', () => {
  it('passes through every attribute (filter steps do not decorate)', () => {
    const out = spatialFilterGenerator.outputSchema(FIELDS, {
      otherSource: { kind: 'data_layer', itemId: 'p' },
      predicate: 'intersects',
    });
    expect(out).toBe(FIELDS);
  });
});

describe('spatialFilterGenerator.outwardReachMeters', () => {
  it('returns 0 for non-near predicates', () => {
    expect(
      spatialFilterGenerator.outwardReachMeters({
        otherSource: { kind: 'data_layer', itemId: 'p' },
        predicate: 'intersects',
      }),
    ).toBe(0);
  });

  it('returns the distance for near predicate', () => {
    expect(
      spatialFilterGenerator.outwardReachMeters({
        otherSource: { kind: 'data_layer', itemId: 'p' },
        predicate: 'near',
        distanceMeters: 500,
      }),
    ).toBe(500);
  });
});

describe('spatialFilterGenerator.extractDependencies', () => {
  it('returns the data_layer itemId for data_layer source', () => {
    expect(
      spatialFilterGenerator.extractDependencies({
        otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
        predicate: 'intersects',
      }),
    ).toEqual({ itemIds: ['parcels-001'], urls: [] });
  });

  it('returns no references for inline-geometry source', () => {
    expect(
      spatialFilterGenerator.extractDependencies({
        otherSource: { kind: 'inline-geometry', geometry: {} },
        predicate: 'intersects',
      }),
    ).toEqual({ itemIds: [], urls: [] });
  });
});

describe('spatialFilterGenerator.toSql', () => {
  it('emits ST_Intersects + EXISTS against data_layer right side', () => {
    const fragment = spatialFilterGenerator.toSql(
      'source',
      {
        otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
        predicate: 'intersects',
      },
      0,
    );
    expect(fragment.sql).toMatch(/ST_Intersects\(l\.geom, r\.geom\)/);
    expect(fragment.sql).toMatch(/EXISTS \(/);
    expect(fragment.sql).toMatch(/FROM source l/);
    expect(fragment.sql).toMatch(/right_rows/);
  });

  it('uses ST_DWithin on geography when predicate is near', () => {
    const fragment = spatialFilterGenerator.toSql(
      'step_2',
      {
        otherSource: { kind: 'data_layer', itemId: 'parcels-001' },
        predicate: 'near',
        distanceMeters: 250,
      },
      0,
    );
    expect(fragment.sql).toMatch(
      /ST_DWithin\(l\.geom::geography, r\.geom::geography, \$1\)/,
    );
    expect(fragment.params).toContain(250);
  });

  it('switches to ST_Within / ST_Contains / ST_Touches by predicate', () => {
    for (const [predicate, fn] of [
      ['within', 'ST_Within'],
      ['contains', 'ST_Contains'],
      ['touches', 'ST_Touches'],
    ] as const) {
      const fragment = spatialFilterGenerator.toSql(
        'source',
        {
          otherSource: { kind: 'data_layer', itemId: 'p' },
          predicate,
        },
        0,
      );
      expect(fragment.sql).toMatch(new RegExp(`${fn}\\(l\\.geom, r\\.geom\\)`));
    }
  });

  it('inlines GeoJSON through ST_GeomFromGeoJSON for inline-geometry source', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-80, 38],
          [-79, 38],
          [-79, 39],
          [-80, 39],
          [-80, 38],
        ],
      ],
    };
    const fragment = spatialFilterGenerator.toSql(
      'source',
      {
        otherSource: { kind: 'inline-geometry', geometry: polygon },
        predicate: 'intersects',
      },
      0,
    );
    expect(fragment.sql).toMatch(/ST_GeomFromGeoJSON\(\$1\)/);
    expect(fragment.params[0]).toBe(JSON.stringify(polygon));
  });

  it('respects paramOffset when numbering placeholders', () => {
    const fragment = spatialFilterGenerator.toSql(
      'source',
      {
        otherSource: { kind: 'data_layer', itemId: 'p' },
        predicate: 'near',
        distanceMeters: 100,
      },
      4,
    );
    // First placeholder a `near` predicate emits is $5 (4 already in
    // the outer query + 1 for our meters value).
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
  });

  it('appends a featureIds restriction CTE when a subset is specified', () => {
    const fragment = spatialFilterGenerator.toSql(
      'source',
      {
        otherSource: {
          kind: 'data_layer',
          itemId: 'parcels-001',
          featureIds: [ID_A, ID_B],
        },
        predicate: 'intersects',
      },
      0,
    );
    // global_id is a uuid column; text[] has no matching operator.
    expect(fragment.sql).toMatch(/r\.global_id = ANY\(\$1::uuid\[\]\)/);
    expect(fragment.params[0]).toEqual([ID_A, ID_B]);
  });

  it('refuses feature ids that are not uuids with a 400', () => {
    expect(() =>
      spatialFilterGenerator.toSql(
        'source',
        {
          otherSource: { kind: 'data_layer', itemId: 'parcels-001', featureIds: ['abc'] },
          predicate: 'intersects',
        },
        0,
      ),
    ).toThrow(BadRequestException);
  });
});
