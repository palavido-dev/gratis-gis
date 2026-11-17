// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Folder contents returned each child's raw data while the item list
// and detail reads redact it for viewers. A viewer reached secrets
// (anonymous markup token, sync conflict rows) through a folder.

import { ItemsService } from './items.service.js';

describe('listFolderContents redaction', () => {
  it('runs every child row through redactRow', async () => {
    const service = Object.create(ItemsService.prototype) as ItemsService;
    const child = { id: 'c1', type: 'map', data: { anonymousAuthorToken: 'secret' } };
    Object.assign(service, {
      get: async () => ({ id: 'f', type: 'folder', data: { childItemIds: ['c1'] } }),
      sharing: { visibleWhere: () => ({}) },
      prisma: { item: { findMany: async () => [child] } },
    });
    const seen: unknown[] = [];
    (service as unknown as { redactRow: (u: unknown, r: unknown) => unknown }).redactRow = (_u, r) => {
      seen.push(r);
      return { ...(r as object), data: {} };
    };
    const rows = (await service.listFolderContents({ id: 'viewer' } as never, 'f')) as Array<{ data: unknown }>;
    expect(seen).toEqual([child]);
    expect(rows[0]!.data).toEqual({});
  });
});
