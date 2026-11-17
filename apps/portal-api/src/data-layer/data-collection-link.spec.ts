// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { linkedDataCollection } from './data-collection-link.js';

const LAYER = '50000000-0000-4000-8000-000000000001';
const OTHER_LAYER = '50000000-0000-4000-8000-000000000002';
const MAP = '50000000-0000-4000-8000-000000000003';
const DC = '50000000-0000-4000-8000-000000000004';
const user = { id: 'u' } as AuthUser;

function deps(opts: { readable?: boolean; type?: string; mapLayers?: string[] }) {
  const items = {
    get: jest.fn(async () => {
      if (opts.readable === false) throw new NotFoundException();
      return {
        id: DC,
        title: 'Survey',
        ownerId: 'owner',
        type: opts.type ?? 'data_collection',
        data: { mapId: MAP },
      };
    }),
  };
  const prisma = {
    item: {
      findUnique: jest.fn(async () => ({
        type: 'map',
        deletedAt: null,
        data: {
          layers: (opts.mapLayers ?? [LAYER]).map((itemId) => ({
            id: `l-${itemId}`,
            source: { kind: 'data-layer', itemId },
          })),
        },
      })),
    },
  };
  return { items, prisma };
}

describe('x-data-collection-id is honoured only when linked', () => {
  it('accepts a readable data_collection whose map shows the layer', async () => {
    const { items, prisma } = deps({});
    await expect(
      linkedDataCollection(prisma as never, items as never, user, DC, LAYER),
    ).resolves.toEqual({ id: DC, title: 'Survey', ownerId: 'owner' });
  });

  it('ignores a data_collection the caller cannot read', async () => {
    const { items, prisma } = deps({ readable: false });
    await expect(
      linkedDataCollection(prisma as never, items as never, user, DC, LAYER),
    ).resolves.toBeNull();
  });

  it('ignores a data_collection whose map does not show the layer', async () => {
    const { items, prisma } = deps({ mapLayers: [OTHER_LAYER] });
    await expect(
      linkedDataCollection(prisma as never, items as never, user, DC, LAYER),
    ).resolves.toBeNull();
  });

  it('ignores an item that is not a data_collection', async () => {
    const { items, prisma } = deps({ type: 'map' });
    await expect(
      linkedDataCollection(prisma as never, items as never, user, DC, LAYER),
    ).resolves.toBeNull();
  });
});
