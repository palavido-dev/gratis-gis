// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import { ItemsService } from './items.service.js';

/**
 * Save-time rejection of author values that a client renders without
 * escaping: a tool's open-url (passed to location.assign) and a map
 * layer's style colors (interpolated into legend SVG). Same harness
 * as attribution-write-path.spec.ts.
 */

function contributor(): AuthUser {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    orgId: '00000000-0000-0000-0000-0000000000bb',
    orgRole: 'contributor',
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES.contributor),
  } as unknown as AuthUser;
}

interface Captured {
  data?: unknown;
}

function serviceForCreate(captured: Captured): ItemsService {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  Object.assign(svc, {
    prisma: {
      item: {
        create: async (args: {
          data: { data?: unknown; type?: unknown; title?: unknown };
        }) => {
          captured.data = args.data.data;
          return {
            id: 'item-1',
            type: args.data.type,
            title: args.data.title,
            data: args.data.data,
            updatedAt: new Date(),
            thumbnailUrl: null,
            thumbnailDesign: null,
          };
        },
      },
    },
  });
  return svc;
}

function serviceForUpdate(
  captured: Captured,
  existing: { type: string; data: unknown },
): ItemsService {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  const row = {
    id: 'item-1',
    orgId: '00000000-0000-0000-0000-0000000000bb',
    type: existing.type,
    title: 'Item',
    tags: [],
    data: existing.data,
    updatedAt: new Date(),
  };
  Object.assign(svc, {
    get: async () => row,
    sharing: { canEdit: () => true },
    prisma: {
      itemShare: { findMany: async () => [] },
      item: {
        update: async (args: { data: { data?: unknown } }) => {
          captured.data = args.data.data;
          return { ...row, ...args.data };
        },
      },
    },
  });
  return svc;
}

const HOSTILE_COLOR =
  '"/><iframe srcdoc="<script>alert(1)</script>"></iframe><svg x="';

describe('tool open-url on save', () => {
  it('rejects a javascript: URL on create', async () => {
    const captured: Captured = {};
    await expect(
      serviceForCreate(captured).create(contributor(), {
        type: 'tool',
        title: 'Hostile',
        data: { action: { kind: 'open-url', url: 'javascript:alert(1)' } },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(captured.data).toBeUndefined();
  });

  it('rejects a protocol-relative URL on update', async () => {
    const captured: Captured = {};
    const svc = serviceForUpdate(captured, { type: 'tool', data: {} });
    await expect(
      svc.update(contributor(), 'item-1', {
        data: { action: { kind: 'open-url', url: '//evil.example/x' } },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['', '/items/abc?view=run', 'https://example.com/tool'])(
    'accepts %j',
    async (url) => {
      const captured: Captured = {};
      await serviceForCreate(captured).create(contributor(), {
        type: 'tool',
        title: 'Ok',
        data: { action: { kind: 'open-url', url } },
      } as never);
      expect(captured.data).toEqual({ action: { kind: 'open-url', url } });
    },
  );
});

describe('map style colors on save', () => {
  it('rejects a color that breaks out of the legend SVG', async () => {
    const captured: Captured = {};
    const svc = serviceForUpdate(captured, { type: 'map', data: { layers: [] } });
    await expect(
      svc.update(contributor(), 'item-1', {
        data: {
          layers: [{ id: 'l1', style: { point: { color: HOSTILE_COLOR } } }],
        },
      } as never),
    ).rejects.toThrow(/layers\[0\]\.style\.point\.color/);
    expect(captured.data).toBeUndefined();
  });

  it('accepts a cleared color on update', async () => {
    const captured: Captured = {};
    const data = { layers: [{ id: 'l1', style: { point: { color: '' } } }] };
    const svc = serviceForUpdate(captured, { type: 'map', data });
    await svc.update(contributor(), 'item-1', { data } as never);
    expect(captured.data).toEqual(data);
  });

  it('accepts ordinary colors', async () => {
    const captured: Captured = {};
    const data = {
      layers: [
        {
          id: 'l1',
          style: {
            point: { color: '#6366f1', strokeColor: 'rgba(0, 0, 0, 0.5)' },
            renderer: { kind: 'class-breaks', colors: ['red', 'hsl(1 2% 3%)'] },
          },
        },
      ],
    };
    await serviceForCreate(captured).create(contributor(), {
      type: 'map',
      title: 'Map',
      data,
    } as never);
    expect(captured.data).toEqual(data);
  });
});
