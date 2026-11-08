// SPDX-License-Identifier: AGPL-3.0-or-later
import { carryLayerSyncVersions } from './items.service.js';

function tx(stored: unknown) {
  return { $queryRaw: jest.fn().mockResolvedValue([{ data: stored }]) } as never;
}

describe('carryLayerSyncVersions', () => {
  it('keeps the stored syncVersion, not the one the client sent', async () => {
    const next = await carryLayerSyncVersions(
      tx({ layers: [{ id: 'a', syncVersion: 9 }] }),
      'item-1',
      { version: 3, layers: [{ id: 'a', syncVersion: 4, title: 'renamed' }] },
    );
    expect(next).toEqual({
      version: 3,
      layers: [{ id: 'a', title: 'renamed', syncVersion: 9 }],
    });
  });

  it('drops a client syncVersion on a layer the server has no value for', async () => {
    const next = await carryLayerSyncVersions(
      tx({ layers: [{ id: 'a' }] }),
      'item-1',
      { layers: [{ id: 'a', syncVersion: 50 }, { id: 'new', syncVersion: 2 }] },
    );
    expect(next).toEqual({ layers: [{ id: 'a' }, { id: 'new' }] });
  });

  it('leaves data without layers unchanged', async () => {
    const data = { version: 1, features: [] };
    expect(await carryLayerSyncVersions(tx({ layers: [] }), 'item-1', data)).toBe(data);
  });
});
