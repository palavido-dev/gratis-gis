// SPDX-License-Identifier: AGPL-3.0-or-later
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ShowcaseService } from './showcase.service.js';

const admin = {
  id: 'user-1',
  orgId: 'org-1',
  orgRole: 'admin',
  capabilities: new Set(['can_publish_items']),
} as unknown as AuthUser;

const viewer = {
  id: 'user-2',
  orgId: 'org-1',
  orgRole: 'viewer',
  capabilities: new Set<string>(),
} as unknown as AuthUser;

describe('ShowcaseService', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showcase-'));
  const feature = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'feat-1',
        properties: { name: 'One' },
        geometry: { type: 'Point', coordinates: [-80, 39] },
      },
    ],
  };
  writeFileSync(
    path.join(dir, 'points.geojson.gz'),
    gzipSync(Buffer.from(JSON.stringify(feature))),
  );
  writeFileSync(
    path.join(dir, 'catalog.json'),
    JSON.stringify({
      items: [
        {
          key: 'layer',
          seedKind: 'sample:showcase-layer',
          type: 'data_layer',
          title: 'Points',
          description: 'A point.',
          tags: ['sample', 'showcase'],
          access: 'public',
          data: { version: 1, layers: [{ id: 'points', name: 'points' }] },
          features: { points: 'points.geojson.gz' },
        },
        {
          key: 'app',
          seedKind: 'sample:showcase-app',
          type: 'web_app',
          title: 'Dashboard',
          description: 'Uses {{layer}}.',
          tags: ['sample', 'showcase'],
          access: 'public',
          data: { mapId: '{{layer}}' },
          features: {},
        },
      ],
    }),
  );

  beforeEach(() => {
    process.env.GRATIS_GIS_SHOWCASE_PATH = dir;
  });

  it('refuses a viewer', async () => {
    const service = new ShowcaseService(
      { item: { findMany: jest.fn() } } as never,
      { create: jest.fn(), update: jest.fn() } as never,
      { listFeatures: jest.fn(), insertFeatures: jest.fn() } as never,
    );
    await expect(service.seed(viewer)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates items with fresh ids and rewrites placeholders', async () => {
    const created: Array<{ seedKind?: string; data: unknown; id: string }> = [];
    const items = {
      create: jest.fn(async (_user, input: { id: string; seedKind?: string; data: unknown }) => {
        created.push(input);
        return { id: input.id, access: 'private', data: input.data };
      }),
      update: jest.fn(async () => ({})),
    };
    const features = {
      listFeatures: jest.fn(async () => ({ features: [] })),
      insertFeatures: jest.fn(async () => ({ inserted: 1 })),
    };
    const prisma = { item: { findMany: jest.fn(async () => []) } };
    const service = new ShowcaseService(prisma as never, items as never, features as never);
    const result = await service.seed(admin);
    expect(result.created).toEqual([
      'sample:showcase-layer',
      'sample:showcase-app',
      'sample:showcase-folder',
    ]);
    const layer = created.find((row) => row.seedKind === 'sample:showcase-layer');
    const app = created.find((row) => row.seedKind === 'sample:showcase-app');
    expect(layer?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect((app?.data as { mapId: string }).mapId).toBe(layer?.id);
    expect(features.insertFeatures).toHaveBeenCalledTimes(1);
    expect(items.update).toHaveBeenCalledWith(admin, layer?.id, { access: 'public' });
  });

  it('skips a seedKind that is already present', async () => {
    const items = { create: jest.fn(), update: jest.fn() };
    const features = {
      listFeatures: jest.fn(async () => ({ features: [{ id: 'already' }] })),
      insertFeatures: jest.fn(),
    };
    const prisma = {
      item: {
        findMany: jest.fn(async () => [
          { id: 'existing-layer', seedKind: 'sample:showcase-layer', access: 'public' },
          { id: 'existing-app', seedKind: 'sample:showcase-app', access: 'public' },
          { id: 'existing-folder', seedKind: 'sample:showcase-folder', access: 'private' },
        ]),
      },
    };
    const service = new ShowcaseService(prisma as never, items as never, features as never);
    const result = await service.seed(admin);
    expect(result.created).toEqual([]);
    expect(result.skipped).toContain('sample:showcase-layer');
    expect(items.create).not.toHaveBeenCalled();
    expect(features.insertFeatures).not.toHaveBeenCalled();
  });
});
