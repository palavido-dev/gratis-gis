import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { nearestNeighborGenerator } from './nearest-neighbor.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
];

describe('nearestNeighborGenerator.validate', () => {
  it('accepts an empty params object', () => {
    expect(nearestNeighborGenerator.validate({})).toEqual({});
  });

  it('rejects non-objects', () => {
    expect(() => nearestNeighborGenerator.validate(null)).toThrow(
      BadRequestException,
    );
    expect(() => nearestNeighborGenerator.validate([])).toThrow(
      BadRequestException,
    );
  });
});

describe('nearestNeighborGenerator.outputSchema', () => {
  it('appends nearest_distance_m to the input schema', () => {
    const out = nearestNeighborGenerator.outputSchema(FIELDS, {});
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      name: 'nearest_distance_m',
      label: 'Distance to nearest (m)',
      type: 'number',
      nullable: true,
    });
  });
});

describe('nearestNeighborGenerator.outwardReachMeters', () => {
  it('returns 0 (geometry is unchanged)', () => {
    expect(nearestNeighborGenerator.outwardReachMeters({})).toBe(0);
  });
});

describe('nearestNeighborGenerator.toSql', () => {
  it('emits a self-join with ST_Distance over geography', () => {
    const fragment = nearestNeighborGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_Distance\(/);
    expect(fragment.sql).toMatch(/::geography/);
    // self-join references inputAlias twice (a and b) and excludes
    // self.
    expect(fragment.sql).toMatch(/FROM source a/);
    expect(fragment.sql).toMatch(/FROM source b/);
    expect(fragment.sql).toMatch(/b\.global_id <> a\.global_id/);
  });

  it('merges nearest_distance_m into properties via jsonb_build_object', () => {
    const fragment = nearestNeighborGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/jsonb_build_object\(\s*'nearest_distance_m'/);
  });

  it('returns no params and ignores paramOffset', () => {
    expect(nearestNeighborGenerator.toSql('source', {}, 0).params).toEqual([]);
    const offset = nearestNeighborGenerator.toSql('step_2', {}, 5);
    expect(offset.params).toEqual([]);
    expect(offset.sql).not.toMatch(/\$/);
  });
});
