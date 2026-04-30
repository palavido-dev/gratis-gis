import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { bufferGenerator } from './buffer.js';

const STRING_FIELD: FeatureField = {
  name: 'name',
  label: 'Name',
  type: 'string',
  nullable: false,
};
const NUMBER_FIELD: FeatureField = {
  name: 'radius_m',
  label: 'Radius (m)',
  type: 'number',
  nullable: true,
};

describe('bufferGenerator.validate (fixed mode)', () => {
  it('accepts the v1 shape ({ distance, unit: meters }) for back-compat', () => {
    const result = bufferGenerator.validate({ distance: 100, unit: 'meters' });
    expect(result).toEqual({ mode: 'fixed', distance: 100, unit: 'meters' });
  });

  it('accepts an explicit fixed-mode shape with a non-meter unit', () => {
    const result = bufferGenerator.validate({
      mode: 'fixed',
      distance: 1,
      unit: 'kilometers',
    });
    expect(result).toEqual({
      mode: 'fixed',
      distance: 1,
      unit: 'kilometers',
    });
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

  it('rejects distances above the world-spanning ceiling, in meters', () => {
    expect(() =>
      bufferGenerator.validate({ distance: 1_000_000, unit: 'meters' }),
    ).toThrow(/must not exceed/);
  });

  it('rejects unit-converted distances above the meters ceiling', () => {
    // 1000 km = 1_000_000 m, well past the ceiling.
    expect(() =>
      bufferGenerator.validate({
        mode: 'fixed',
        distance: 1000,
        unit: 'kilometers',
      }),
    ).toThrow(/must not exceed/);
  });

  it('rejects unknown unit names', () => {
    expect(() =>
      bufferGenerator.validate({ distance: 100, unit: 'parsecs' }),
    ).toThrow(/must be one of/);
  });
});

describe('bufferGenerator.validate (field mode)', () => {
  it('accepts a field-mode shape with a known numeric field', () => {
    const result = bufferGenerator.validate(
      { mode: 'field', field: 'radius_m', unit: 'meters' },
      { sourceSchema: [STRING_FIELD, NUMBER_FIELD] },
    );
    expect(result).toEqual({
      mode: 'field',
      field: 'radius_m',
      unit: 'meters',
      cachedMaxMeters: 0,
    });
  });

  it('rejects a missing field name', () => {
    expect(() =>
      bufferGenerator.validate({ mode: 'field', unit: 'meters' }),
    ).toThrow(/field is required/);
  });

  it('rejects a field that does not exist on the source schema', () => {
    expect(() =>
      bufferGenerator.validate(
        { mode: 'field', field: 'nope', unit: 'meters' },
        { sourceSchema: [STRING_FIELD, NUMBER_FIELD] },
      ),
    ).toThrow(/does not exist on the source schema/);
  });

  it('rejects a field that is not numeric', () => {
    expect(() =>
      bufferGenerator.validate(
        { mode: 'field', field: 'name', unit: 'meters' },
        { sourceSchema: [STRING_FIELD, NUMBER_FIELD] },
      ),
    ).toThrow(/must be a number field/);
  });

  it('skips schema checks when no context is provided (read-time path)', () => {
    // With no schema context, validate trusts the persisted shape.
    const result = bufferGenerator.validate({
      mode: 'field',
      field: 'whatever_was_persisted',
      unit: 'feet',
      cachedMaxMeters: 1500,
    });
    expect(result).toEqual({
      mode: 'field',
      field: 'whatever_was_persisted',
      unit: 'feet',
      cachedMaxMeters: 1500,
    });
  });

  it('clamps a client-supplied cachedMaxMeters to the global ceiling', () => {
    const result = bufferGenerator.validate({
      mode: 'field',
      field: 'radius_m',
      unit: 'meters',
      cachedMaxMeters: 999_999_999,
    });
    expect((result as { cachedMaxMeters: number }).cachedMaxMeters).toBe(
      100_000,
    );
  });
});

describe('bufferGenerator.enrich', () => {
  it('queries MAX(field) and bakes the result as cachedMaxMeters', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ max_value: 250 }] as unknown[]);
    const enriched = await bufferGenerator.enrich!(
      {
        mode: 'field',
        field: 'radius_m',
        unit: 'meters',
        cachedMaxMeters: 0,
      },
      {
        sourceSchema: [NUMBER_FIELD],
        sourceTable: '"fs_xyz"',
        queryRaw,
      },
    );
    expect(enriched).toEqual({
      mode: 'field',
      field: 'radius_m',
      unit: 'meters',
      cachedMaxMeters: 250,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ...args] = queryRaw.mock.calls[0]!;
    expect(sql).toMatch(/MAX\(/);
    expect(sql).toMatch(/properties->>\$1/);
    expect(args).toEqual(['radius_m']);
  });

  it('converts the raw max into meters using the recipe unit', async () => {
    // Source values stored in feet; max(field) = 100 feet = 30.48 m.
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ max_value: 100 }] as unknown[]);
    const enriched = await bufferGenerator.enrich!(
      {
        mode: 'field',
        field: 'radius_m',
        unit: 'feet',
        cachedMaxMeters: 0,
      },
      {
        sourceSchema: [NUMBER_FIELD],
        sourceTable: '"fs_xyz"',
        queryRaw,
      },
    );
    expect((enriched as { cachedMaxMeters: number }).cachedMaxMeters).toBeCloseTo(
      30.48,
      4,
    );
  });

  it('clamps the cached cap to the global meters ceiling', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ max_value: 1000 }] as unknown[]); // 1000 km = 1_000_000 m
    const enriched = await bufferGenerator.enrich!(
      {
        mode: 'field',
        field: 'radius_m',
        unit: 'kilometers',
        cachedMaxMeters: 0,
      },
      {
        sourceSchema: [NUMBER_FIELD],
        sourceTable: '"fs_xyz"',
        queryRaw,
      },
    );
    expect((enriched as { cachedMaxMeters: number }).cachedMaxMeters).toBe(
      100_000,
    );
  });

  it('returns zero when the source is empty or has no positive values', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ max_value: 0 }] as unknown[]);
    const enriched = await bufferGenerator.enrich!(
      {
        mode: 'field',
        field: 'radius_m',
        unit: 'meters',
        cachedMaxMeters: 0,
      },
      {
        sourceSchema: [NUMBER_FIELD],
        sourceTable: '"fs_xyz"',
        queryRaw,
      },
    );
    expect((enriched as { cachedMaxMeters: number }).cachedMaxMeters).toBe(0);
  });

  it('passes through fixed-mode params unchanged', async () => {
    const queryRaw = jest.fn();
    const fixed = {
      mode: 'fixed' as const,
      distance: 100,
      unit: 'meters' as const,
    };
    const enriched = await bufferGenerator.enrich!(fixed, {
      sourceSchema: [],
      sourceTable: '"fs_xyz"',
      queryRaw,
    });
    expect(enriched).toBe(fixed);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('bufferGenerator.outputSchema', () => {
  it('passes through the source schema unchanged', () => {
    const fields: FeatureField[] = [STRING_FIELD, NUMBER_FIELD];
    expect(
      bufferGenerator.outputSchema(fields, {
        mode: 'fixed',
        distance: 100,
        unit: 'meters',
      }),
    ).toBe(fields);
  });
});

describe('bufferGenerator.outwardReachMeters', () => {
  it('returns the buffer distance in meters for fixed mode', () => {
    expect(
      bufferGenerator.outwardReachMeters({
        mode: 'fixed',
        distance: 250,
        unit: 'meters',
      }),
    ).toBe(250);
  });

  it('converts unit to meters for fixed mode', () => {
    expect(
      bufferGenerator.outwardReachMeters({
        mode: 'fixed',
        distance: 1,
        unit: 'kilometers',
      }),
    ).toBe(1000);
  });

  it('returns the cached cap for field mode', () => {
    expect(
      bufferGenerator.outwardReachMeters({
        mode: 'field',
        field: 'r',
        unit: 'meters',
        cachedMaxMeters: 750,
      }),
    ).toBe(750);
  });
});

describe('bufferGenerator.extractDependencies', () => {
  it('returns no item or url references in v1', () => {
    expect(
      bufferGenerator.extractDependencies({
        mode: 'fixed',
        distance: 100,
        unit: 'meters',
      }),
    ).toEqual({ itemIds: [], urls: [] });
  });
});

describe('bufferGenerator.toSql (fixed mode)', () => {
  it('emits a CTE body that buffers via geography casting', () => {
    const fragment = bufferGenerator.toSql(
      'source',
      { mode: 'fixed', distance: 250, unit: 'meters' },
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
      { mode: 'fixed', distance: 50, unit: 'meters' },
      4,
    );
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
    expect(fragment.params).toEqual([50]);
  });

  it('converts non-meter units to meters in the emitted parameter', () => {
    const fragment = bufferGenerator.toSql(
      'source',
      { mode: 'fixed', distance: 1, unit: 'kilometers' },
      0,
    );
    expect(fragment.params).toEqual([1000]);
  });
});

describe('bufferGenerator.toSql (field mode)', () => {
  it('reads per-feature distance from properties JSON, converts to meters, and clamps to the cached cap', () => {
    const fragment = bufferGenerator.toSql(
      'source',
      {
        mode: 'field',
        field: 'radius_m',
        unit: 'meters',
        cachedMaxMeters: 500,
      },
      0,
    );
    // Three placeholders: $1 = field name, $2 = unit factor, $3 = cap.
    expect(fragment.params).toEqual(['radius_m', 1, 500]);
    expect(fragment.sql).toMatch(/properties->>\$1/);
    expect(fragment.sql).toMatch(/\* \$2/);
    expect(fragment.sql).toMatch(/LEAST\(/);
    expect(fragment.sql).toMatch(/\$3/);
    // Skips rows with non-numeric field values rather than erroring.
    expect(fragment.sql).toMatch(/properties \? \$1/);
    expect(fragment.sql).toMatch(/~ '\^-\?\[0-9\]/);
  });

  it('emits the kilometers unit factor (1000) for kilometer-unit recipes', () => {
    const fragment = bufferGenerator.toSql(
      'source',
      {
        mode: 'field',
        field: 'radius_km',
        unit: 'kilometers',
        cachedMaxMeters: 50_000,
      },
      0,
    );
    expect(fragment.params).toEqual(['radius_km', 1000, 50_000]);
  });

  it('honors paramOffset so multi-step pipelines stay parameter-safe', () => {
    const fragment = bufferGenerator.toSql(
      'step_1',
      {
        mode: 'field',
        field: 'r',
        unit: 'meters',
        cachedMaxMeters: 100,
      },
      4,
    );
    // First placeholder a step at offset 4 should emit is $5.
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).toMatch(/\$6/);
    expect(fragment.sql).toMatch(/\$7/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
  });
});
