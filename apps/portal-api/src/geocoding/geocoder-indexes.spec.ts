// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { GeocodingService } from './geocoding.service.js';
import {
  GEOCODER_INDEXES_PER_ORG,
  GEOCODER_INDEX_NAME,
  dropGeocoderIndexes,
  geocoderIndexName,
  geocoderIndexPrefix,
} from './geocoder-indexes.js';

/**
 * Geocoder indexes live on the shared, partitioned observation table.
 * Building or dropping one locks writes for every layer in every org,
 * so only org admins may rebuild, each org's total is capped, and the
 * indexes go when the geocoder is purged.
 */
const ORG = 'org-1';
const GEO = '11111111-2222-4333-8444-555555555555';

function user(orgRole: 'contributor' | 'admin'): AuthUser {
  return { id: 'u1', orgId: ORG, orgRole } as unknown as AuthUser;
}

function makeService(opts: { otherOrgIndexes: number; existing?: string[]; sublayer?: string }) {
  const ddl: string[] = [];
  const geocoder = {
    id: GEO,
    orgId: ORG,
    type: 'geocoding_service',
    data: { version: 1, sourceLayerId: 'src', searchFields: [{ name: 'name' }] },
  };
  const prisma: Record<string, unknown> = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('LIKE ANY')) return [{ n: BigInt(opts.otherOrgIndexes) }];
      if (sql.includes('COUNT(*)')) return [{ count: 0n }];
      if (sql.includes('FROM pg_indexes')) {
        return (opts.existing ?? []).map((indexname) => ({ indexname }));
      }
      return [];
    }),
    $executeRawUnsafe: jest.fn(async (q: string) => {
      ddl.push(q);
      return 0;
    }),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma)),
    item: { findMany: async () => [{ id: 'other-geocoder' }] },
  };
  const svc = new GeocodingService(
    prisma as never,
    {
      get: async (_u: unknown, id: string) =>
        id === GEO ? geocoder : { id: 'src', type: 'data_layer', data: {} },
    } as never,
    { canAdmin: () => true } as never,
  );
  const internals = svc as unknown as {
    resolveSublayerId: () => string;
    validateSearchFields: () => Array<{ name: string }>;
  };
  internals.resolveSublayerId = () => opts.sublayer ?? 'L1';
  internals.validateSearchFields = () => [{ name: 'name' }];
  return { svc, ddl };
}

describe('geocoder index rebuild', () => {
  it('refuses the owner when they are not an org admin', async () => {
    const { svc, ddl } = makeService({ otherOrgIndexes: 0 });
    await expect(svc.rebuildIndexes(user('contributor'), GEO)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ddl).toHaveLength(0);
  });

  it('builds for an org admin', async () => {
    const { svc, ddl } = makeService({ otherOrgIndexes: 0 });
    const out = await svc.rebuildIndexes(user('admin'), GEO);
    expect(out.created).toHaveLength(1);
    expect(ddl.some((q) => q.includes('CREATE INDEX'))).toBe(true);
  });

  it('lifts the statement timeout for the build only, inside its transaction', async () => {
    const { svc, ddl } = makeService({ otherOrgIndexes: 0 });
    await svc.rebuildIndexes(user('admin'), GEO);
    const build = ddl.findIndex((q) => q.includes('CREATE INDEX'));
    expect(ddl.slice(0, build)).toContain('SET LOCAL statement_timeout = 0');
  });

  it('rebuilds when the geocoder is pointed at another layer with the same field', async () => {
    const oldName = geocoderIndexName(GEO, 'data_layer:src:L1', 'name');
    const { svc, ddl } = makeService({
      otherOrgIndexes: 0,
      existing: [oldName],
      sublayer: 'L2',
    });
    const out = await svc.rebuildIndexes(user('admin'), GEO);
    expect(out.kept).toEqual([]);
    expect(out.dropped).toEqual([oldName]);
    expect(out.created).toEqual([geocoderIndexName(GEO, 'data_layer:src:L2', 'name')]);
    expect(ddl.some((q) => q.includes("scope = 'data_layer:src:L2'"))).toBe(true);
  });

  it('gives two long fields with the same start their own index names', () => {
    const a = geocoderIndexName(GEO, 's', `${'x'.repeat(40)}_a`);
    const b = geocoderIndexName(GEO, 's', `${'x'.repeat(40)}_b`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).toMatch(GEOCODER_INDEX_NAME);
  });

  it('refuses past the per-org cap without touching the table', async () => {
    const { svc, ddl } = makeService({ otherOrgIndexes: GEOCODER_INDEXES_PER_ORG });
    await expect(svc.rebuildIndexes(user('admin'), GEO)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ddl.some((q) => q.includes('CREATE INDEX'))).toBe(false);
  });
});

describe('dropGeocoderIndexes', () => {
  it('drops only the well-formed indexes of this geocoder', async () => {
    const prefix = geocoderIndexPrefix(GEO);
    const ddl: string[] = [];
    const dropped = await dropGeocoderIndexes(
      {
        $queryRaw: (async () => [
          { indexname: `${prefix}name` },
          { indexname: `${prefix}bad"name` },
        ]) as never,
        $executeRawUnsafe: async (q: string) => {
          ddl.push(q);
          return 0;
        },
      },
      GEO,
    );
    expect(dropped).toEqual([`${prefix}name`]);
    expect(ddl).toEqual([`DROP INDEX IF EXISTS "${prefix}name"`]);
  });
});
