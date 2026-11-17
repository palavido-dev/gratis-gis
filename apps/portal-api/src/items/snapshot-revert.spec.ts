// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { ItemsService } from './items.service.js';

/**
 * A snapshot revert used to write the stored blob straight back,
 * skipping the checks and normalizers a normal data save runs. It now
 * goes through ItemsService.update, which owns all of them (and the
 * row lock and syncVersion carry), with a note on the pre-save
 * snapshot that points back at the target.
 */
describe('ItemsService.revertToSnapshot', () => {
  function fake(snapItemId: string) {
    const self = {
      snapshots: {
        get: jest.fn(async () => ({
          id: 'snap-1',
          itemId: snapItemId,
          data: { version: 3, layers: [] },
        })),
      },
      update: jest.fn(async () => ({})),
    };
    const revert = (ItemsService.prototype.revertToSnapshot as (
      this: unknown,
      ...args: unknown[]
    ) => Promise<unknown>).bind(self);
    return { self, revert };
  }

  it('writes the snapshot through update with a revert note', async () => {
    const { self, revert } = fake('item-1');
    const user = { id: 'u1' };
    await expect(revert(user, 'item-1', 'snap-1')).resolves.toEqual({
      itemId: 'item-1',
      revertedFrom: 'snap-1',
    });
    expect(self.update).toHaveBeenCalledWith(
      user,
      'item-1',
      { data: { version: 3, layers: [] } },
      { snapshotNote: 'pre-revert to snapshot snap-1' },
    );
  });

  it('refuses a snapshot of another item', async () => {
    const { self, revert } = fake('item-2');
    await expect(revert({ id: 'u1' }, 'item-1', 'snap-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(self.update).not.toHaveBeenCalled();
  });
});
