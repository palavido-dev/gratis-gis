// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from './items.service.js';

/**
 * The map access matrix's "Everyone else" column. A custom layer used
 * to be hidden from every viewer no user or group entry named: org
 * members reaching the map through org-wide sharing, and anonymous
 * viewers of a public map. An 'everyone' entry now covers them, and a
 * named entry still wins over it.
 */
function svc(): ItemsService {
  const s = Object.create(ItemsService.prototype) as ItemsService;
  Object.assign(s, { prisma: { item: { findMany: async () => [] } } });
  return s;
}

const viewer = (id: string, groupIds: string[] = []) =>
  ({ id, groupIds }) as unknown as AuthUser;

const map = {
  layers: [
    {
      id: 'parcels',
      access: {
        policy: 'custom',
        entries: [
          { principalType: 'user', principalId: 'bob', view: true, query: false, edit: false },
          { principalType: 'group', principalId: 'crew', view: false, query: false, edit: false },
          { principalType: 'everyone', principalId: '*', view: true, query: true, edit: false },
        ],
      },
    },
  ],
};

async function seen(v: AuthUser | null) {
  const out = (await svc().filterMapForViewer(v, map)) as {
    layers: Array<{ id: string; effective: { query: boolean } }>;
  };
  return out.layers;
}

describe('filterMapForViewer, Everyone else entry', () => {
  it('applies to org members and anonymous viewers no entry names', async () => {
    expect((await seen(viewer('carol')))[0]?.effective.query).toBe(true);
    expect((await seen(null))[0]?.effective.query).toBe(true);
  });

  it('does not override a named user or group entry', async () => {
    expect((await seen(viewer('bob')))[0]?.effective.query).toBe(false);
    expect(await seen(viewer('dave', ['crew']))).toEqual([]);
  });

  it('hides the layer from unnamed viewers when there is no such entry', async () => {
    const noEveryone = {
      layers: [{ ...map.layers[0], access: { policy: 'custom', entries: map.layers[0]!.access.entries.slice(0, 2) } }],
    };
    const out = (await svc().filterMapForViewer(viewer('carol'), noEveryone)) as { layers: unknown[] };
    expect(out.layers).toEqual([]);
  });
});
