// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConflictException, NotFoundException } from '@nestjs/common';

import { ItemsService } from './items.service.js';

/**
 * Bulk reassign used to move items one by one and stop at the first
 * bad id, leaving the earlier ones moved and returning a bare error.
 * It now checks every item before moving any.
 */
describe('ItemsService.bulkReassignOwner', () => {
  function svcWith(bad: string | null, failWrite: string | null = null) {
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    const apply = jest.fn(async (_u: unknown, item: { id: string }) => {
      if (item.id === failWrite) throw new Error('db down');
      return item;
    });
    Object.assign(svc, {
      prepareReassign: jest.fn(async (_u: unknown, id: string) => {
        if (id === bad) throw new NotFoundException('Item not found');
        return { id, ownerId: 'old' };
      }),
      applyReassign: apply,
    });
    return { svc, apply };
  }

  it('moves nothing when any item fails its checks', async () => {
    const { svc, apply } = svcWith('b');
    await expect(
      svc.bulkReassignOwner({ id: 'admin' } as never, {
        itemIds: ['a', 'b', 'c'],
        newOwnerId: 'new',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(apply).not.toHaveBeenCalled();
  });

  it('moves every item when all pass', async () => {
    const { svc, apply } = svcWith(null);
    await expect(
      svc.bulkReassignOwner({ id: 'admin' } as never, {
        itemIds: ['a', 'b'],
        newOwnerId: 'new',
      }),
    ).resolves.toEqual({ reassigned: 2 });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('says how far it got when a write fails', async () => {
    const { svc } = svcWith(null, 'b');
    await expect(
      svc.bulkReassignOwner({ id: 'admin' } as never, {
        itemIds: ['a', 'b', 'c'],
        newOwnerId: 'new',
      }),
    ).rejects.toThrow(new ConflictException('Reassigned 1 of 3 items, then failed on b: db down'));
  });
});
