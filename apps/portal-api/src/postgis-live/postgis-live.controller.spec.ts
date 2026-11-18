// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';

import { PostgisLiveController } from './postgis-live.controller.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { _resetKeyCacheForTests } from '../items/credential-cipher.js';

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const author = { id: 'u1', capabilities: new Set(['can_publish_items']) } as unknown as AuthUser;
const table = { name: 'public.parcels', title: 'parcels', geometryKind: 'Polygon' };

function setup() {
  const svc = {
    testConnection: jest.fn(async () => ({ ok: true })),
    probe: jest.fn(async () => [table]),
  };
  const items = {
    create: jest.fn(async () => ({ id: SERVICE_ID })),
    get: jest.fn(async () => ({ id: SERVICE_ID, data: { protocol: 'postgis_live', layers: [] } })),
    update: jest.fn(async (_u: AuthUser, id: string, input: unknown) => ({
      id,
      ...(input as object),
    })),
    remove: jest.fn(async () => undefined),
    purge: jest.fn(async () => undefined),
  };
  const credentials = { setCredential: jest.fn(async () => undefined) };
  const controller = new PostgisLiveController(svc as never, items as never, credentials as never);
  return { controller, svc, items, credentials };
}

const dto = {
  title: 'Assets',
  host: 'db.example.org',
  port: 5432,
  database: 'gis',
  role: 'reader',
  password: 'secret',
};

describe('PostgisLiveController', () => {
  const savedKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = savedKey;
    _resetKeyCacheForTests();
  });

  describe('create', () => {
    it('stops before creating anything when no credential key is set', async () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      _resetKeyCacheForTests();
      const { controller, items, svc } = setup();
      await expect(controller.create(author, dto as never)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(svc.testConnection).not.toHaveBeenCalled();
      expect(items.create).not.toHaveBeenCalled();
    });

    it('removes the new item again when a later step fails', async () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
      _resetKeyCacheForTests();
      const { controller, items, svc } = setup();
      svc.probe.mockRejectedValueOnce(new Error('permission denied for schema'));
      await expect(controller.create(author, dto as never)).rejects.toThrow(
        'permission denied for schema',
      );
      expect(items.remove).toHaveBeenCalledWith(author, SERVICE_ID);
      expect(items.purge).toHaveBeenCalledWith(author, SERVICE_ID);
    });
  });

  describe('probe', () => {
    it('stores the fresh table list on the item', async () => {
      const { controller, items } = setup();
      await expect(controller.probe(author, SERVICE_ID)).resolves.toEqual([table]);
      expect(items.update).toHaveBeenCalledWith(author, SERVICE_ID, {
        data: { protocol: 'postgis_live', layers: [table] },
      });
    });

    it('still returns the list to a user who may not edit the item', async () => {
      const { controller, items } = setup();
      items.update.mockRejectedValueOnce(new ForbiddenException());
      await expect(controller.probe(author, SERVICE_ID)).resolves.toEqual([table]);
    });
  });
});
