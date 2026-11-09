// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { assertPostgisLayersOnSave, isValidSrid } from './postgis-host.js';
import { PostgisLiveService_ } from './postgis-live.service.js';

/**
 * PostGIS Live interpolated `layers[].srid` from item data into SQL
 * unchecked, and kept one pool per item forever, so a host or
 * password change only took effect after a restart.
 */

const USER = { id: 'u1', orgId: 'o1', orgRole: 'admin', groupIds: [] } as unknown as AuthUser;

function service(data: Record<string, unknown>, credentialUpdatedAt = new Date(0)) {
  const prisma = {
    item: {
      findFirst: jest.fn(async () => ({
        id: 'svc-1',
        type: 'service',
        orgId: 'o1',
        ownerId: 'u1',
        access: 'private',
        data,
      })),
    },
    itemShare: { findMany: jest.fn(async () => []) },
  };
  const credentials = {
    getCredentialMeta: jest.fn(async () => ({
      kind: 'basic',
      hasSecret: true,
      updatedAt: credentialUpdatedAt,
      updatedBy: 'u1',
    })),
    getCredentialForProxy: jest.fn(async () => ({
      kind: 'basic',
      username: 'r',
      password: 'pw',
    })),
  };
  const sharing = { canRead: () => true };
  const svc = new PostgisLiveService_(prisma as never, credentials as never, sharing as never);
  return { svc, credentials };
}

const base = {
  protocol: 'postgis_live',
  host: 'db.example.org',
  port: 5432,
  database: 'gis',
  role: 'reader',
};

describe('PostGIS Live srid', () => {
  it('refuses a layer srid that is not a plain integer before any SQL runs', async () => {
    const { svc, credentials } = service({
      ...base,
      layers: [
        {
          name: 'public.parcels',
          geometryColumn: 'geom',
          srid: '2229) FROM pg_shadow --',
          columns: [],
        },
      ],
    });
    await expect(
      svc.readFeatures(USER, 'svc-1', {
        tableName: 'public.parcels',
        bbox: [-118, 33, -117, 34],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(credentials.getCredentialForProxy).not.toHaveBeenCalled();
  });

  it('validates srid on save', () => {
    expect(isValidSrid(2229)).toBe(true);
    expect(isValidSrid('2229')).toBe(false);
    expect(isValidSrid(1.5)).toBe(false);
    expect(() =>
      assertPostgisLayersOnSave({ ...base, layers: [{ srid: '(SELECT 1)' }] }),
    ).toThrow(BadRequestException);
    expect(() => assertPostgisLayersOnSave({ ...base, layers: [{ srid: 4326 }] })).not.toThrow();
    expect(() =>
      assertPostgisLayersOnSave({ protocol: 'wms', layers: [{ srid: 'x' }] }),
    ).not.toThrow();
  });
});

describe('PostGIS Live pools', () => {
  type PoolAccess = { getPool(id: string, data: unknown): Promise<Pool> };

  it('reuses the pool while nothing changed, and rebuilds it when the host or password changes', async () => {
    let stamp = new Date(1_000);
    const { svc, credentials } = service(base);
    credentials.getCredentialMeta.mockImplementation(async () => ({
      kind: 'basic',
      hasSecret: true,
      updatedAt: stamp,
      updatedBy: 'u1',
    }));
    const access = svc as unknown as PoolAccess;
    const first = await access.getPool('svc-1', base);
    expect(await access.getPool('svc-1', base)).toBe(first);

    const endFirst = jest.spyOn(first, 'end');
    const moved = await access.getPool('svc-1', { ...base, host: 'other.example.org' });
    expect(moved).not.toBe(first);
    expect(endFirst).toHaveBeenCalled();

    const endMoved = jest.spyOn(moved, 'end');
    stamp = new Date(2_000);
    const repassworded = await access.getPool('svc-1', { ...base, host: 'other.example.org' });
    expect(repassworded).not.toBe(moved);
    expect(endMoved).toHaveBeenCalled();
    await repassworded.end();
  });
});
