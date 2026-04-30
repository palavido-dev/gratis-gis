import type { FeatureField } from '@gratis-gis/shared-types';

import { densifyGenerator } from './densify.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
];

describe('densifyGenerator.validate', () => {
  it('accepts a positive maxSegmentLength in meters', () => {
    expect(
      densifyGenerator.validate({ maxSegmentLength: 100, unit: 'meters' }),
    ).toEqual({ maxSegmentLength: 100, unit: 'meters' });
  });

  it('defaults unit to meters', () => {
    expect(
      densifyGenerator.validate({ maxSegmentLength: 100 }),
    ).toEqual({ maxSegmentLength: 100, unit: 'meters' });
  });

  it('rejects below the minimum', () => {
    expect(() =>
      densifyGenerator.validate({ maxSegmentLength: 0.5, unit: 'meters' }),
    ).toThrow(/at least 1 meter/);
  });

  it('rejects above the meters ceiling, including unit-converted', () => {
    expect(() =>
      densifyGenerator.validate({
        maxSegmentLength: 1_000_000,
        unit: 'meters',
      }),
    ).toThrow(/must not exceed/);
    expect(() =>
      densifyGenerator.validate({
        maxSegmentLength: 1000,
        unit: 'kilometers',
      }),
    ).toThrow(/must not exceed/);
  });

  it('rejects non-numeric maxSegmentLength', () => {
    expect(() =>
      densifyGenerator.validate({ maxSegmentLength: '100', unit: 'meters' }),
    ).toThrow(/finite number/);
  });
});

describe('densifyGenerator.outputSchema', () => {
  it('passes through every attribute', () => {
    expect(
      densifyGenerator.outputSchema(FIELDS, {
        maxSegmentLength: 100,
        unit: 'meters',
      }),
    ).toBe(FIELDS);
  });
});

describe('densifyGenerator.outwardReachMeters', () => {
  it('returns 0 (densify only adds vertices on existing edges)', () => {
    expect(
      densifyGenerator.outwardReachMeters({
        maxSegmentLength: 1000,
        unit: 'meters',
      }),
    ).toBe(0);
  });
});

describe('densifyGenerator.toSql', () => {
  it('emits ST_Segmentize on geography with the parameter in meters', () => {
    const fragment = densifyGenerator.toSql(
      'source',
      { maxSegmentLength: 100, unit: 'meters' },
      0,
    );
    expect(fragment.sql).toMatch(/ST_Segmentize\(geom::geography, \$1\)/);
    expect(fragment.params).toEqual([100]);
  });

  it('converts non-meter units to meters', () => {
    const fragment = densifyGenerator.toSql(
      'source',
      { maxSegmentLength: 1, unit: 'kilometers' },
      0,
    );
    expect(fragment.params).toEqual([1000]);
  });

  it('preserves SRID 4326', () => {
    const fragment = densifyGenerator.toSql(
      'source',
      { maxSegmentLength: 100, unit: 'meters' },
      0,
    );
    expect(fragment.sql).toMatch(/ST_SetSRID\(/);
    expect(fragment.sql).toMatch(/4326/);
  });

  it('honors paramOffset', () => {
    const fragment = densifyGenerator.toSql(
      'step_1',
      { maxSegmentLength: 50, unit: 'meters' },
      4,
    );
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
  });
});
