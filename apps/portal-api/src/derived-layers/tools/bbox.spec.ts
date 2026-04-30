import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { bboxGenerator } from './bbox.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
];

describe('bboxGenerator.validate', () => {
  it('accepts an empty params object', () => {
    expect(bboxGenerator.validate({})).toEqual({});
  });

  it('rejects non-objects', () => {
    expect(() => bboxGenerator.validate(null)).toThrow(BadRequestException);
    expect(() => bboxGenerator.validate([])).toThrow(BadRequestException);
  });
});

describe('bboxGenerator.outputSchema', () => {
  it('passes through every attribute', () => {
    expect(bboxGenerator.outputSchema(FIELDS, {})).toBe(FIELDS);
  });
});

describe('bboxGenerator.outwardReachMeters', () => {
  it('returns 0', () => {
    expect(bboxGenerator.outwardReachMeters({})).toBe(0);
  });
});

describe('bboxGenerator.extractDependencies', () => {
  it('returns no references', () => {
    expect(bboxGenerator.extractDependencies({})).toEqual({
      itemIds: [],
      urls: [],
    });
  });
});

describe('bboxGenerator.toSql', () => {
  it('emits ST_Envelope per row, SRID-wrapped', () => {
    const fragment = bboxGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_Envelope\(geom\)/);
    expect(fragment.sql).toMatch(/ST_SetSRID\(/);
    expect(fragment.sql).toMatch(/4326/);
    expect(fragment.sql).toMatch(/FROM source/);
    expect(fragment.sql).toMatch(/WHERE geom IS NOT NULL/);
  });

  it('returns no params and ignores paramOffset', () => {
    expect(bboxGenerator.toSql('source', {}, 0).params).toEqual([]);
    const offset = bboxGenerator.toSql('step_3', {}, 5);
    expect(offset.params).toEqual([]);
    expect(offset.sql).not.toMatch(/\$/);
  });
});
