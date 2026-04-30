import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { convexHullGenerator } from './convex-hull.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
];

describe('convexHullGenerator.validate', () => {
  it('accepts an empty params object', () => {
    expect(convexHullGenerator.validate({})).toEqual({});
  });

  it('rejects non-objects', () => {
    expect(() => convexHullGenerator.validate(null)).toThrow(
      BadRequestException,
    );
    expect(() => convexHullGenerator.validate([])).toThrow(BadRequestException);
  });
});

describe('convexHullGenerator.outputSchema', () => {
  it('passes through every attribute', () => {
    expect(convexHullGenerator.outputSchema(FIELDS, {})).toBe(FIELDS);
  });
});

describe('convexHullGenerator.outwardReachMeters', () => {
  it('returns 0', () => {
    expect(convexHullGenerator.outwardReachMeters({})).toBe(0);
  });
});

describe('convexHullGenerator.extractDependencies', () => {
  it('returns no references', () => {
    expect(convexHullGenerator.extractDependencies({})).toEqual({
      itemIds: [],
      urls: [],
    });
  });
});

describe('convexHullGenerator.toSql', () => {
  it('emits ST_ConvexHull per row', () => {
    const fragment = convexHullGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_ConvexHull\(geom\)/);
    expect(fragment.sql).toMatch(/FROM source/);
    expect(fragment.sql).toMatch(/WHERE geom IS NOT NULL/);
  });

  it('preserves SRID 4326', () => {
    const fragment = convexHullGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_SetSRID\(/);
    expect(fragment.sql).toMatch(/4326/);
  });

  it('returns no params and ignores paramOffset', () => {
    expect(convexHullGenerator.toSql('source', {}, 0).params).toEqual([]);
    const offset = convexHullGenerator.toSql('step_3', {}, 5);
    expect(offset.params).toEqual([]);
    expect(offset.sql).not.toMatch(/\$/);
  });
});
