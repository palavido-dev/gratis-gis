import type { FeatureField } from '@gratis-gis/shared-types';

import { calculateGeometryGenerator } from './calculate-geometry.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
];

describe('calculateGeometryGenerator.validate', () => {
  it('accepts an area-mode shape', () => {
    expect(
      calculateGeometryGenerator.validate({
        measurement: 'area',
        unit: 'hectares',
        fieldName: 'parcel_ha',
      }),
    ).toEqual({ measurement: 'area', unit: 'hectares', fieldName: 'parcel_ha' });
  });

  it('accepts a length-mode shape', () => {
    expect(
      calculateGeometryGenerator.validate({
        measurement: 'length',
        unit: 'kilometers',
        fieldName: 'length_km',
      }),
    ).toEqual({
      measurement: 'length',
      unit: 'kilometers',
      fieldName: 'length_km',
    });
  });

  it('accepts a perimeter-mode shape', () => {
    expect(
      calculateGeometryGenerator.validate({
        measurement: 'perimeter',
        unit: 'meters',
        fieldName: 'perimeter_m',
      }),
    ).toEqual({
      measurement: 'perimeter',
      unit: 'meters',
      fieldName: 'perimeter_m',
    });
  });

  it('rejects unknown measurement', () => {
    expect(() =>
      calculateGeometryGenerator.validate({
        measurement: 'volume',
        unit: 'meters',
        fieldName: 'x',
      }),
    ).toThrow(/'length', 'perimeter', or 'area'/);
  });

  it('rejects an area unit on length / perimeter', () => {
    expect(() =>
      calculateGeometryGenerator.validate({
        measurement: 'length',
        unit: 'hectares',
        fieldName: 'x',
      }),
    ).toThrow(/length/);
  });

  it('rejects a length unit on area', () => {
    expect(() =>
      calculateGeometryGenerator.validate({
        measurement: 'area',
        unit: 'meters',
        fieldName: 'x',
      }),
    ).toThrow(/area/);
  });

  it('rejects a missing or empty fieldName', () => {
    expect(() =>
      calculateGeometryGenerator.validate({
        measurement: 'area',
        unit: 'square-meters',
      }),
    ).toThrow(/fieldName is required/);
    expect(() =>
      calculateGeometryGenerator.validate({
        measurement: 'area',
        unit: 'square-meters',
        fieldName: '',
      }),
    ).toThrow(/fieldName is required/);
  });

  it('rejects an invalid identifier-shaped fieldName', () => {
    expect(() =>
      calculateGeometryGenerator.validate({
        measurement: 'area',
        unit: 'square-meters',
        fieldName: '1bad',
      }),
    ).toThrow(/start with a letter or underscore/);
    expect(() =>
      calculateGeometryGenerator.validate({
        measurement: 'area',
        unit: 'square-meters',
        fieldName: 'has-dash',
      }),
    ).toThrow(/letters, numbers, and underscores/);
  });

  it('rejects reserved field names', () => {
    expect(() =>
      calculateGeometryGenerator.validate({
        measurement: 'area',
        unit: 'square-meters',
        fieldName: '_global_id',
      }),
    ).toThrow(/reserved/);
  });

  it('rejects a fieldName that already exists on the source schema', () => {
    expect(() =>
      calculateGeometryGenerator.validate(
        {
          measurement: 'area',
          unit: 'square-meters',
          fieldName: 'name',
        },
        { sourceSchema: FIELDS },
      ),
    ).toThrow(/already exists on the source schema/);
  });

  it('skips the schema clash check when no context is provided (read-time path)', () => {
    expect(
      calculateGeometryGenerator.validate({
        measurement: 'area',
        unit: 'square-meters',
        fieldName: 'name',
      }),
    ).toEqual({
      measurement: 'area',
      unit: 'square-meters',
      fieldName: 'name',
    });
  });
});

describe('calculateGeometryGenerator.outputSchema', () => {
  it('appends the new field to the input schema', () => {
    const out = calculateGeometryGenerator.outputSchema(FIELDS, {
      measurement: 'area',
      unit: 'hectares',
      fieldName: 'area_ha',
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      name: 'area_ha',
      label: 'area_ha',
      type: 'number',
      nullable: true,
    });
  });
});

describe('calculateGeometryGenerator.outwardReachMeters', () => {
  it('returns 0', () => {
    expect(
      calculateGeometryGenerator.outwardReachMeters({
        measurement: 'area',
        unit: 'square-meters',
        fieldName: 'x',
      }),
    ).toBe(0);
  });
});

describe('calculateGeometryGenerator.toSql', () => {
  it('uses ST_Area on geography for area mode', () => {
    const fragment = calculateGeometryGenerator.toSql(
      'source',
      { measurement: 'area', unit: 'hectares', fieldName: 'area_ha' },
      0,
    );
    expect(fragment.sql).toMatch(/ST_Area\(source\.geom::geography\)/);
    // 1 hectare = 10_000 m^2; the conversion factor is the divisor.
    expect(fragment.params).toEqual(['area_ha', 10_000]);
  });

  it('uses ST_Length on geography for length mode', () => {
    const fragment = calculateGeometryGenerator.toSql(
      'source',
      { measurement: 'length', unit: 'kilometers', fieldName: 'len_km' },
      0,
    );
    expect(fragment.sql).toMatch(/ST_Length\(source\.geom::geography\)/);
    expect(fragment.params).toEqual(['len_km', 1000]);
  });

  it('uses ST_Length(ST_Boundary(...)) for perimeter mode', () => {
    const fragment = calculateGeometryGenerator.toSql(
      'source',
      { measurement: 'perimeter', unit: 'meters', fieldName: 'perim' },
      0,
    );
    expect(fragment.sql).toMatch(
      /ST_Length\(ST_Boundary\(source\.geom\)::geography\)/,
    );
    expect(fragment.params).toEqual(['perim', 1]);
  });

  it('merges the new field into properties via jsonb_build_object', () => {
    const fragment = calculateGeometryGenerator.toSql(
      'source',
      { measurement: 'area', unit: 'square-meters', fieldName: 'area_m2' },
      0,
    );
    expect(fragment.sql).toMatch(/jsonb_build_object\(\s*\$1/);
  });

  it('honors paramOffset', () => {
    const fragment = calculateGeometryGenerator.toSql(
      'step_2',
      { measurement: 'area', unit: 'square-meters', fieldName: 'a' },
      4,
    );
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).toMatch(/\$6/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
  });
});
