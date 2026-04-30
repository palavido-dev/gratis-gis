import type { FeatureField } from '@gratis-gis/shared-types';

import { randomSampleGenerator } from './random-sample.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
];

describe('randomSampleGenerator.validate', () => {
  it('accepts a percentage-mode params shape', () => {
    expect(
      randomSampleGenerator.validate({
        mode: 'percentage',
        value: 25,
        seed: 42,
      }),
    ).toEqual({ mode: 'percentage', value: 25, seed: 42 });
  });

  it('accepts a count-mode params shape', () => {
    expect(
      randomSampleGenerator.validate({
        mode: 'count',
        value: 100,
        seed: 7,
      }),
    ).toEqual({ mode: 'count', value: 100, seed: 7 });
  });

  it('defaults unknown mode to percentage', () => {
    const r = randomSampleGenerator.validate({
      mode: 'fudge',
      value: 50,
      seed: 1,
    });
    expect(r.mode).toBe('percentage');
  });

  it('rejects non-positive value', () => {
    expect(() =>
      randomSampleGenerator.validate({
        mode: 'percentage',
        value: 0,
        seed: 1,
      }),
    ).toThrow(/positive number/);
    expect(() =>
      randomSampleGenerator.validate({
        mode: 'percentage',
        value: -1,
        seed: 1,
      }),
    ).toThrow(/positive number/);
  });

  it('rejects percentage above 100', () => {
    expect(() =>
      randomSampleGenerator.validate({
        mode: 'percentage',
        value: 101,
        seed: 1,
      }),
    ).toThrow(/at most 100/);
  });

  it('rejects fractional value in count mode', () => {
    expect(() =>
      randomSampleGenerator.validate({
        mode: 'count',
        value: 5.5,
        seed: 1,
      }),
    ).toThrow(/integer in count mode/);
  });

  it('rejects count above the global ceiling', () => {
    expect(() =>
      randomSampleGenerator.validate({
        mode: 'count',
        value: 9_999_999,
        seed: 1,
      }),
    ).toThrow(/must not exceed/);
  });

  it('substitutes a default seed when the input is 0', () => {
    const r = randomSampleGenerator.validate({
      mode: 'percentage',
      value: 50,
      seed: 0,
    });
    expect(r.seed).not.toBe(0);
  });
});

describe('randomSampleGenerator.outputSchema', () => {
  it('passes through every attribute', () => {
    expect(
      randomSampleGenerator.outputSchema(FIELDS, {
        mode: 'percentage',
        value: 10,
        seed: 1,
      }),
    ).toBe(FIELDS);
  });
});

describe('randomSampleGenerator.outwardReachMeters', () => {
  it('returns 0', () => {
    expect(
      randomSampleGenerator.outwardReachMeters({
        mode: 'percentage',
        value: 10,
        seed: 1,
      }),
    ).toBe(0);
  });
});

describe('randomSampleGenerator.toSql', () => {
  it('emits an md5-threshold WHERE in percentage mode', () => {
    const fragment = randomSampleGenerator.toSql(
      'source',
      { mode: 'percentage', value: 25, seed: 42 },
      0,
    );
    expect(fragment.sql).toMatch(/md5\(global_id::text \|\| \$1::text\)/);
    expect(fragment.sql).toMatch(/< \(\$2::double precision \/ 100\.0\)/);
    expect(fragment.params).toEqual([42, 25]);
  });

  it('emits ORDER BY md5 + LIMIT in count mode', () => {
    const fragment = randomSampleGenerator.toSql(
      'source',
      { mode: 'count', value: 7, seed: 12 },
      0,
    );
    expect(fragment.sql).toMatch(/ORDER BY md5\(/);
    expect(fragment.sql).toMatch(/LIMIT \$2/);
    expect(fragment.params).toEqual([12, 7]);
  });

  it('honors paramOffset', () => {
    const fragment = randomSampleGenerator.toSql(
      'step_2',
      { mode: 'percentage', value: 50, seed: 1 },
      4,
    );
    expect(fragment.sql).toMatch(/\$5/);
    expect(fragment.sql).toMatch(/\$6/);
    expect(fragment.sql).not.toMatch(/\$1\b/);
  });
});
