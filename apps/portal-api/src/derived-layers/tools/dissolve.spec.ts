import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { dissolveGenerator } from './dissolve.js';

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

describe('dissolveGenerator.validate', () => {
  it('accepts an empty params object', () => {
    expect(dissolveGenerator.validate({})).toEqual({});
  });

  it('tolerates extra keys on the params object for forward-compat', () => {
    // A future schema version might add a `groupBy` field; this
    // server should accept and ignore unknown keys rather than
    // 400 on a payload from a newer client.
    expect(dissolveGenerator.validate({ groupBy: 'name' })).toEqual({});
  });

  it('rejects a non-object', () => {
    expect(() => dissolveGenerator.validate(null)).toThrow(BadRequestException);
    expect(() => dissolveGenerator.validate('dissolve')).toThrow(
      BadRequestException,
    );
  });

  it('rejects an array', () => {
    // An array is technically an object in JS but not what the
    // params slot expects; reject it so a client bug surfaces
    // rather than silently being treated as empty.
    expect(() => dissolveGenerator.validate([])).toThrow(BadRequestException);
  });
});

describe('dissolveGenerator.outputSchema', () => {
  it('drops every input attribute', () => {
    expect(
      dissolveGenerator.outputSchema([STRING_FIELD, NUMBER_FIELD], {}),
    ).toEqual([]);
  });

  it('returns a fresh array (not the input reference)', () => {
    const input: FeatureField[] = [];
    const out = dissolveGenerator.outputSchema(input, {});
    expect(out).not.toBe(input);
    expect(out).toEqual([]);
  });
});

describe('dissolveGenerator.outwardReachMeters', () => {
  it('returns 0', () => {
    expect(dissolveGenerator.outwardReachMeters({})).toBe(0);
  });
});

describe('dissolveGenerator.extractDependencies', () => {
  it('returns no item or url references in v1', () => {
    expect(dissolveGenerator.extractDependencies({})).toEqual({
      itemIds: [],
      urls: [],
    });
  });
});

describe('dissolveGenerator.toSql', () => {
  it('emits ST_Union over the input alias', () => {
    const fragment = dissolveGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_Union\(geom\)/);
    expect(fragment.sql).toMatch(/FROM source/);
    expect(fragment.sql).toMatch(/WHERE geom IS NOT NULL/);
  });

  it('preserves SRID 4326 on the dissolved geometry', () => {
    const fragment = dissolveGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_SetSRID\(/);
    expect(fragment.sql).toMatch(/4326/);
  });

  it('produces a stable global_id and empty properties on the output', () => {
    const fragment = dissolveGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/gen_random_uuid\(\)/);
    expect(fragment.sql).toMatch(/'\{\}'::jsonb AS properties/);
  });

  it('returns an empty params array (no parameter slots needed)', () => {
    const fragment = dissolveGenerator.toSql('source', {}, 0);
    expect(fragment.params).toEqual([]);
  });

  it('honors paramOffset in chained pipelines (no $N collisions)', () => {
    // Even though dissolve emits no params, the alias the service
    // hands in is the only thing the SQL touches, so paramOffset
    // is structurally irrelevant. The interface contract still
    // requires fragment.params to be empty regardless of offset.
    const fragment = dissolveGenerator.toSql('step_2', {}, 7);
    expect(fragment.params).toEqual([]);
    expect(fragment.sql).toMatch(/FROM step_2/);
    expect(fragment.sql).not.toMatch(/\$/);
  });
});
