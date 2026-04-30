import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { simplifyGenerator } from './simplify.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
];

describe('simplifyGenerator.validate', () => {
  it('accepts a positive tolerance in meters', () => {
    expect(simplifyGenerator.validate({ tolerance: 10, unit: 'meters' })).toEqual({
      tolerance: 10,
      unit: 'meters',
    });
  });

  it('defaults unit to meters when missing', () => {
    expect(simplifyGenerator.validate({ tolerance: 10 })).toEqual({
      tolerance: 10,
      unit: 'meters',
    });
  });

  it('accepts non-meter units', () => {
    expect(simplifyGenerator.validate({ tolerance: 1, unit: 'kilometers' })).toEqual({
      tolerance: 1,
      unit: 'kilometers',
    });
  });

  it('rejects a non-object', () => {
    expect(() => simplifyGenerator.validate(null)).toThrow(BadRequestException);
  });

  it('rejects non-number tolerance', () => {
    expect(() =>
      simplifyGenerator.validate({ tolerance: '10', unit: 'meters' }),
    ).toThrow(/finite number/);
  });

  it('rejects zero or negative tolerance', () => {
    expect(() =>
      simplifyGenerator.validate({ tolerance: 0, unit: 'meters' }),
    ).toThrow(/greater than 0/);
    expect(() =>
      simplifyGenerator.validate({ tolerance: -1, unit: 'meters' }),
    ).toThrow(/greater than 0/);
  });

  it('rejects tolerances above the meters ceiling, including unit-converted', () => {
    expect(() =>
      simplifyGenerator.validate({ tolerance: 1_000_000, unit: 'meters' }),
    ).toThrow(/must not exceed/);
    expect(() =>
      simplifyGenerator.validate({ tolerance: 1000, unit: 'kilometers' }),
    ).toThrow(/must not exceed/);
  });
});

describe('simplifyGenerator.outputSchema', () => {
  it('passes through every attribute', () => {
    expect(
      simplifyGenerator.outputSchema(FIELDS, {
        tolerance: 10,
        unit: 'meters',
      }),
    ).toBe(FIELDS);
  });
});

describe('simplifyGenerator.outwardReachMeters', () => {
  it('returns 0 (simplify only drops vertices)', () => {
    expect(
      simplifyGenerator.outwardReachMeters({ tolerance: 100, unit: 'meters' }),
    ).toBe(0);
  });
});

describe('simplifyGenerator.toSql', () => {
  it('emits ST_Simplify with the tolerance in degrees', () => {
    const fragment = simplifyGenerator.toSql(
      'source',
      { tolerance: 111.32, unit: 'meters' },
      0,
    );
    expect(fragment.sql).toMatch(/ST_Simplify\(geom, \$1\)/);
    // 111.32m / 111_320 m/deg = ~0.001 deg.
    expect(fragment.params[0]).toBeCloseTo(0.001, 5);
  });

  it('converts non-meter units to degrees correctly', () => {
    // 1 km = 1000m; 1000 / 111_320 ~= 0.00898 deg.
    const fragment = simplifyGenerator.toSql(
      'source',
      { tolerance: 1, unit: 'kilometers' },
      0,
    );
    expect(fragment.params[0]).toBeCloseTo(0.00898, 4);
  });

  it('honors paramOffset', () => {
    const fragment = simplifyGenerator.toSql(
      'step_2',
      { tolerance: 10, unit: 'meters' },
      4,
    );
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
  });
});
