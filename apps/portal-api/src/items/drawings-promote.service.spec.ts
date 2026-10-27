// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { DrawingFeature, DrawingSet } from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DrawingsPromoteService } from './drawings-promote.service.js';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'author-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

function pin(id: string): DrawingFeature {
  return {
    id,
    kind: 'pin',
    geometry: { type: 'Point', coordinates: [-122.4, 37.8] },
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
}

function line(id: string): DrawingFeature {
  return {
    id,
    kind: 'line',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-122.4, 37.8],
        [-122.41, 37.81],
      ],
    },
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
}

function setWith(features: DrawingFeature[]): DrawingSet {
  return {
    id: 'set-1',
    authorId: 'author-1',
    authorDisplay: 'Alice',
    title: "Alice's markup 2026-10-27",
    color: '#ef4444',
    visible: true,
    features,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
}

describe('DrawingsPromoteService', () => {
  function makeSvc(opts: {
    set: DrawingSet;
    refuseWrite?: boolean;
  }) {
    const drawings = {
      requireWritableSet: jest.fn(async () => {
        if (opts.refuseWrite) {
          throw new ForbiddenException('nope');
        }
        return opts.set;
      }),
    };
    const items = {
      create: jest.fn(async () => ({ id: 'layer-item-1' })),
    };
    const features = {
      insertFeatures: jest.fn(async (_itemId: string, _layerId: string, rows: unknown[]) => ({
        inserted: rows.length,
        deduplicated: 0,
        globalIds: (rows as Array<{ globalId?: string }>).map(
          (r, i) => r.globalId ?? `g-${i}`,
        ),
      })),
    };
    const svc = new DrawingsPromoteService(
      drawings as never,
      items as never,
      features as never,
    );
    return { svc, drawings, items, features };
  }

  it('refuses an empty drawing set', async () => {
    const { svc } = makeSvc({ set: setWith([]) });
    await expect(
      svc.promote({
        user: makeUser(),
        mapId: '11111111-1111-4111-8111-111111111111',
        drawingId: 'set-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('promotes a homogeneous pin set into one point sublayer', async () => {
    const { svc, items, features } = makeSvc({
      set: setWith([pin('p1'), pin('p2')]),
    });
    const out = await svc.promote({
      user: makeUser(),
      mapId: '11111111-1111-4111-8111-111111111111',
      drawingId: 'set-1',
    });
    expect(out.itemId).toBe('layer-item-1');
    expect(out.inserted).toBe(2);
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0]!.geometryType).toBe('point');
    expect(items.create).toHaveBeenCalledTimes(1);
    const createArgs = items.create.mock.calls[0] as unknown as [
      AuthUser,
      { data: { layers: Array<{ geometryType: string }> } },
    ];
    const createdData = createArgs[1].data;
    expect(createdData.layers).toHaveLength(1);
    expect(createdData.layers[0]!.geometryType).toBe('point');
    expect(features.insertFeatures).toHaveBeenCalledTimes(1);
  });

  it('splits mixed pin + line markup into two sublayers on one item', async () => {
    const { svc, features } = makeSvc({
      set: setWith([pin('p1'), line('l1')]),
    });
    const out = await svc.promote({
      user: makeUser(),
      mapId: '11111111-1111-4111-8111-111111111111',
      drawingId: 'set-1',
      title: 'Review round 2',
    });
    expect(out.layers).toHaveLength(2);
    expect(out.layers.map((l) => l.geometryType).sort()).toEqual([
      'line',
      'point',
    ]);
    expect(out.inserted).toBe(2);
    expect(features.insertFeatures).toHaveBeenCalledTimes(2);
  });

  it('propagates the author-or-editor refuse from drawings', async () => {
    const { svc } = makeSvc({
      set: setWith([pin('p1')]),
      refuseWrite: true,
    });
    await expect(
      svc.promote({
        user: makeUser(),
        mapId: '11111111-1111-4111-8111-111111111111',
        drawingId: 'set-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
