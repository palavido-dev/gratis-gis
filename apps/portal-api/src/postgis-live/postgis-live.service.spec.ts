// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { MapLayerFilter } from '@gratis-gis/shared-types';

import { compileFilter } from './postgis-live.service.js';

describe('compileFilter (#158 Phase 1.5)', () => {
  const allowed = new Set(['acres', 'zoning', 'owner']);

  it('returns null for a filter with no clauses', () => {
    const filter: MapLayerFilter = { combinator: 'all', clauses: [] };
    expect(compileFilter(filter, allowed, 0)).toBeNull();
  });

  it('compiles an equality clause with a parameter placeholder', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'zoning', op: '==', value: 'R1' }],
    };
    const out = compileFilter(filter, allowed, 0)!;
    expect(out.sql).toBe('("zoning" = $1)');
    expect(out.params).toEqual(['R1']);
  });

  it('compiles a numeric comparison with the right cast', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'acres', op: '>', value: '5' }],
    };
    const out = compileFilter(filter, allowed, 0)!;
    expect(out.sql).toBe('(("acres")::numeric > $1::numeric)');
    expect(out.params).toEqual([5]);
  });

  it('skips a numeric comparison whose value is NaN', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'acres', op: '>', value: 'not-a-number' }],
    };
    expect(compileFilter(filter, allowed, 0)).toBeNull();
  });

  it('ANDs multi-clause filters with combinator=all', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [
        { field: 'acres', op: '>=', value: '5' },
        { field: 'zoning', op: '==', value: 'R1' },
      ],
    };
    const out = compileFilter(filter, allowed, 0)!;
    expect(out.sql).toBe(
      '(("acres")::numeric >= $1::numeric) AND ("zoning" = $2)',
    );
    expect(out.params).toEqual([5, 'R1']);
  });

  it('ORs multi-clause filters with combinator=any', () => {
    const filter: MapLayerFilter = {
      combinator: 'any',
      clauses: [
        { field: 'zoning', op: '==', value: 'R1' },
        { field: 'zoning', op: '==', value: 'R2' },
      ],
    };
    const out = compileFilter(filter, allowed, 0)!;
    expect(out.sql).toBe('("zoning" = $1) OR ("zoning" = $2)');
    expect(out.params).toEqual(['R1', 'R2']);
  });

  it('honors paramOffset so it dovetails with the caller is outer params', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'zoning', op: '==', value: 'R1' }],
    };
    const out = compileFilter(filter, allowed, 5)!;
    expect(out.sql).toBe('("zoning" = $6)');
  });

  it('throws on a clause that references a column the layer does not expose', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'snoopy', op: '==', value: 'X' }],
    };
    expect(() => compileFilter(filter, allowed, 0)).toThrow(
      BadRequestException,
    );
  });

  it('quietly drops a clause with a malformed identifier', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'drop table parcels --', op: '==', value: 'X' }],
    };
    expect(compileFilter(filter, allowed, 0)).toBeNull();
  });

  it('compiles is-null with no parameters', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'owner', op: 'is-null', value: '' }],
    };
    const out = compileFilter(filter, allowed, 0)!;
    expect(out.sql).toBe('("owner" IS NULL)');
    expect(out.params).toEqual([]);
  });

  it('compiles contains as ILIKE with % and _ escaped from the value', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'owner', op: 'contains', value: '50% off_' }],
    };
    const out = compileFilter(filter, allowed, 0)!;
    expect(out.sql).toBe('(("owner")::text ILIKE $1)');
    expect(out.params).toEqual(['%50\\% off\\_%']);
  });

  it('compiles != as <>', () => {
    const filter: MapLayerFilter = {
      combinator: 'all',
      clauses: [{ field: 'zoning', op: '!=', value: 'R1' }],
    };
    const out = compileFilter(filter, allowed, 0)!;
    expect(out.sql).toBe('("zoning" <> $1)');
  });
});
