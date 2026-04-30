import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { verticesGenerator } from './vertices.js';

const FIELDS: FeatureField[] = [
  { name: 'name', label: 'Name', type: 'string', nullable: false },
];

describe('verticesGenerator.validate', () => {
  it('accepts an empty params object', () => {
    expect(verticesGenerator.validate({})).toEqual({});
  });

  it('rejects non-objects', () => {
    expect(() => verticesGenerator.validate(null)).toThrow(BadRequestException);
    expect(() => verticesGenerator.validate([])).toThrow(BadRequestException);
  });
});

describe('verticesGenerator.outputSchema', () => {
  it('appends vertex_index to the input schema', () => {
    const out = verticesGenerator.outputSchema(FIELDS, {});
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(FIELDS[0]);
    expect(out[1]).toEqual({
      name: 'vertex_index',
      label: 'Vertex index',
      type: 'number',
      nullable: false,
    });
  });

  it('returns a fresh array, not the input reference', () => {
    const input: FeatureField[] = [];
    const out = verticesGenerator.outputSchema(input, {});
    expect(out).not.toBe(input);
  });
});

describe('verticesGenerator.outwardReachMeters', () => {
  it('returns 0 (vertices lie on the input geometry)', () => {
    expect(verticesGenerator.outwardReachMeters({})).toBe(0);
  });
});

describe('verticesGenerator.toSql', () => {
  it('emits ST_DumpPoints under a lateral with vertex_index', () => {
    const fragment = verticesGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_DumpPoints\(source\.geom\)/);
    expect(fragment.sql).toMatch(/LATERAL/);
    expect(fragment.sql).toMatch(/vertex_index/);
  });

  it('orders vertices by path so multi-part geometries enumerate sensibly', () => {
    const fragment = verticesGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ORDER BY pt\.path/);
  });

  it('merges vertex_index into the properties JSONB', () => {
    const fragment = verticesGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/jsonb_build_object\('vertex_index'/);
  });

  it('preserves SRID 4326 on the dumped point geometry', () => {
    const fragment = verticesGenerator.toSql('source', {}, 0);
    expect(fragment.sql).toMatch(/ST_SetSRID\(dp\.geom, 4326\)/);
  });

  it('returns no params and ignores paramOffset', () => {
    expect(verticesGenerator.toSql('source', {}, 0).params).toEqual([]);
    const offset = verticesGenerator.toSql('step_2', {}, 5);
    expect(offset.params).toEqual([]);
    expect(offset.sql).toMatch(/FROM step_2/);
    expect(offset.sql).not.toMatch(/\$/);
  });
});
