// SPDX-License-Identifier: AGPL-3.0-or-later
import { carryLayerSyncVersions } from './items.service.js';
import { carryMapDrawingsFrom } from './item-data-lock.js';

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

// A map Save carries the browser's copy of the markup, which can be
// stale. The stored sets always win so markup added or deleted by
// someone else in the meantime is not undone.
describe('carryMapDrawingsFrom', () => {
  it('keeps the stored drawings and flag, not what the client sent', () => {
    const stored = {
      drawings: [{ id: 's1', anonymousAuthorToken: 'tok' }, { id: 's2' }],
      allowAnonymousDrawings: true,
    };
    const next = carryMapDrawingsFrom(stored, {
      title: 'renamed',
      drawings: [{ id: 's1' }],
      allowAnonymousDrawings: false,
    });
    expect(next).toEqual({ title: 'renamed', ...stored });
  });

  it('drops client markup when the map has none stored', () => {
    expect(
      carryMapDrawingsFrom({}, { drawings: [{ id: 'x' }], layers: [] }),
    ).toEqual({ layers: [] });
  });
});
