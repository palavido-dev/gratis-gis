import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { bufferGenerator } from './buffer.js';

describe('bufferGenerator.validate', () => {
  it('accepts a positive distance in meters', () => {
    const result = bufferGenerator.validate({ distance: 100, unit: 'meters' });
    expect(result).toEqual({ distance: 100, unit: 'meters' });
  });

  it('rejects a non-object', () => {
    expect(() => bufferGenerator.validate(null)).toThrow(BadRequestException);
    expect(() => bufferGenerator.validate('100m')).toThrow(BadRequestException);
  });

  it('rejects a non-number distance', () => {
    expect(() =>
      bufferGenerator.validate({ distance: '100', unit: 'meters' }),
    ).toThrow(/finite number/);
  });

  it('rejects zero or negative distances', () => {
    expect(() =>
      bufferGenerator.validate({ distance: 0, unit: 'meters' }),
    ).toThrow(/greater than 0/);
    expect(() =>
      bufferGenerator.validate({ distance: -5, unit: 'meters' }),
    ).toThrow(/greater than 0/);
  });

  it('rejects distances above the world-spanning ceiling', () => {
    expect(() =>
      bufferGenerator.validate({ distance: 1_000_000, unit: 'meters' }),
    ).toThrow(/must not exceed/);
  });

  it('rejects unknown units', () => {
    expect(() =>
      bufferGenerator.validate({ distance: 100, unit: 'feet' }),
    ).toThrow(/unit must be "meters"/);
  });
});

describe('bufferGenerator.outputSchema', () => {
  it('passes through the source schema unchanged', () => {
    const fields: FeatureField[] = [
      { name: 'name', label: 'Name', type: 'string', nullable: false },
      { name: 'population', label: 'Pop.', type: 'number', nullable: true },
    ];
    expect(
      bufferGenerator.outputSchema(fields, { distance: 100, unit: 'meters' }),
    ).toBe(fields);
  });
});

describe('bufferGenerator.outwardReachMeters', () => {
  it('returns the buffer distance', () => {
    expect(
      bufferGenerator.outwardReachMeters({ distance: 250, unit: 'meters' }),
    ).toBe(250);
  });
});

describe('bufferGenerator.extractDependencies', () => {
  it('returns no item or url references in v1', () => {
    expect(
      bufferGenerator.extractDependencies({ distance: 100, unit: 'meters' }),
    ).toEqual({ itemIds: [], urls: [] });
  });
});

describe('bufferGenerator.toSql', () => {
  it('emits a CTE body that buffers via geography casting', () => {
    const fragment = bufferGenerator.toSql(
      'source',
      { distance: 250, unit: 'meters' },
      0,
    );
    expect(fragment.params).toEqual([250]);
    expect(fragment.sql).toMatch(/ST_Buffer\(geom::geography, \$1\)/);
    expect(fragment.sql).toMatch(/ST_SetSRID\(/);
    expect(fragment.sql).toMatch(/4326/);
    expect(fragment.sql).toMatch(/FROM source/);
    expect(fragment.sql).toMatch(/WHERE geom IS NOT NULL/);
  });

  it('honors paramOffset so multi-step pipelines stay parameter-safe', () => {
    const fragment = bufferGenerator.toSql(
      'step_1',
      { distance: 50, unit: 'meters' },
      4,
    );
    // First placeholder a step at offset 4 should emit is $5.
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
    expect(fragment.params).toEqual([50]);
  });
});
