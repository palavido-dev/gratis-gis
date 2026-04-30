import type { FeatureField } from '@gratis-gis/shared-types';

import { topNGenerator } from './top-n.js';

const STRING_FIELD: FeatureField = {
  name: 'name',
  label: 'Name',
  type: 'string',
  nullable: false,
};
const NUMBER_FIELD: FeatureField = {
  name: 'population',
  label: 'Population',
  type: 'number',
  nullable: true,
};

describe('topNGenerator.validate', () => {
  it('accepts a valid params shape with schema context', () => {
    expect(
      topNGenerator.validate(
        { field: 'population', n: 10, direction: 'desc' },
        { sourceSchema: [STRING_FIELD, NUMBER_FIELD] },
      ),
    ).toEqual({ field: 'population', n: 10, direction: 'desc' });
  });

  it('skips schema checks when no context is provided (read-time path)', () => {
    expect(
      topNGenerator.validate({
        field: 'whatever',
        n: 5,
        direction: 'asc',
      }),
    ).toEqual({ field: 'whatever', n: 5, direction: 'asc' });
  });

  it('rejects a field that does not exist on the source schema', () => {
    expect(() =>
      topNGenerator.validate(
        { field: 'nope', n: 10, direction: 'desc' },
        { sourceSchema: [STRING_FIELD, NUMBER_FIELD] },
      ),
    ).toThrow(/does not exist on the source schema/);
  });

  it('rejects a non-numeric field', () => {
    expect(() =>
      topNGenerator.validate(
        { field: 'name', n: 10, direction: 'desc' },
        { sourceSchema: [STRING_FIELD, NUMBER_FIELD] },
      ),
    ).toThrow(/must be a number field/);
  });

  it('rejects a missing field name', () => {
    expect(() =>
      topNGenerator.validate({ n: 10, direction: 'desc' }),
    ).toThrow(/field is required/);
  });

  it('rejects non-integer or non-positive n', () => {
    expect(() =>
      topNGenerator.validate({ field: 'x', n: 0, direction: 'desc' }),
    ).toThrow(/at least 1/);
    expect(() =>
      topNGenerator.validate({ field: 'x', n: 1.5, direction: 'desc' }),
    ).toThrow(/positive integer/);
    expect(() =>
      topNGenerator.validate({ field: 'x', n: 999_999_999, direction: 'desc' }),
    ).toThrow(/must not exceed/);
  });

  it('coerces unknown direction to desc', () => {
    expect(
      topNGenerator.validate({ field: 'x', n: 10, direction: 'sideways' }),
    ).toEqual({ field: 'x', n: 10, direction: 'desc' });
  });
});

describe('topNGenerator.outputSchema', () => {
  it('passes through every attribute', () => {
    const fields = [STRING_FIELD, NUMBER_FIELD];
    expect(
      topNGenerator.outputSchema(fields, {
        field: 'population',
        n: 5,
        direction: 'desc',
      }),
    ).toBe(fields);
  });
});

describe('topNGenerator.outwardReachMeters', () => {
  it('returns 0', () => {
    expect(
      topNGenerator.outwardReachMeters({
        field: 'x',
        n: 10,
        direction: 'desc',
      }),
    ).toBe(0);
  });
});

describe('topNGenerator.toSql', () => {
  it('emits ORDER BY DESC + LIMIT, parameterized', () => {
    const fragment = topNGenerator.toSql(
      'source',
      { field: 'population', n: 10, direction: 'desc' },
      0,
    );
    expect(fragment.sql).toMatch(/ORDER BY .* DESC NULLS LAST/);
    expect(fragment.sql).toMatch(/LIMIT \$2/);
    expect(fragment.params).toEqual(['population', 10]);
  });

  it('emits ASC for direction=asc', () => {
    const fragment = topNGenerator.toSql(
      'source',
      { field: 'pop', n: 5, direction: 'asc' },
      0,
    );
    expect(fragment.sql).toMatch(/ORDER BY .* ASC NULLS LAST/);
  });

  it('reads from properties->>$field with the same JSONB guard buffer uses', () => {
    const fragment = topNGenerator.toSql(
      'source',
      { field: 'pop', n: 5, direction: 'desc' },
      0,
    );
    expect(fragment.sql).toMatch(/properties \?/);
    expect(fragment.sql).toMatch(/~ '\^-\?\[0-9\]/);
    expect(fragment.sql).toMatch(/double precision/);
  });

  it('honors paramOffset', () => {
    const fragment = topNGenerator.toSql(
      'step_2',
      { field: 'pop', n: 5, direction: 'desc' },
      4,
    );
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).toMatch(/\$6/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
  });
});
