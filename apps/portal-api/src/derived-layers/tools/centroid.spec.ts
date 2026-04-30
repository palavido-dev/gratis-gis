import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { centroidGenerator } from './centroid.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
  { name: 'pop', label: 'Pop', type: 'number', nullable: true },
];

describe('centroidGenerator.validate', () => {
  it('accepts an empty params object', () => {
    expect(centroidGenerator.validate({})).toEqual({});
  });

  it('tolerates extra keys for forward compat', () => {
    expect(centroidGenerator.validate({ note: 'ignored' })).toEqual({});
  });

  it('rejects a non-object', () => {
    expect(() => centroidGenerator.validate(null)).toThrow(BadRequestException);
    expect(() => centroidGenerator.validate('center')).toThrow(
      BadRequestException,
    );
  });

  it('rejects an array', () => {
    expect(() => centroidGenerator.validate([])).toThrow(BadRequestException);
  });
});

describe('centroidGenerator.outputSchema', () => {
  it('passes through every attribute', () => {
    expect(centroidGenerator.outputSchema(FIELDS, {})).toBe(FIELDS);
  });
});

describe('centroidGenerator.outwardReachMeters', () => {
  it('returns 0', () => {
    expect(centroidGenerator.outwardReachMeters({})).toBe(0);
  });
});

describe('centroidGenerator.extractDependencies', () => {
  it('returns no item or url references', () => {
    expect(centroidGenerator.extractDependencies({})).toEqual({
      itemIds: [],
      urls: [],
    });
  });
});

describe('centroidGenerator.toSql', () => {
  it('emits ST_Centroid over the input alias', () => {
    const fragment = centroidGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_Centroid\(geom\)/);
    expect(fragment.sql).toMatch(/FROM source/);
    expect(fragment.sql).toMatch(/WHERE geom IS NOT NULL/);
  });

  it('preserves SRID 4326 on the output', () => {
    const fragment = centroidGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_SetSRID\(/);
    expect(fragment.sql).toMatch(/4326/);
  });

  it('passes properties through unchanged', () => {
    const fragment = centroidGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/\bproperties\b/);
  });

  it('returns an empty params array', () => {
    const fragment = centroidGenerator.toSql('source', {}, 0);
    expect(fragment.params).toEqual([]);
  });

  it('honors paramOffset by emitting no $N placeholders', () => {
    const fragment = centroidGenerator.toSql('step_2', {}, 7);
    expect(fragment.params).toEqual([]);
    expect(fragment.sql).toMatch(/FROM step_2/);
    expect(fragment.sql).not.toMatch(/\$/);
  });
});
