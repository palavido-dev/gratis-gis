// SPDX-License-Identifier: AGPL-3.0-or-later
import { stampV3LayerSource, type V3LayerSourceStamp } from './stamp-layer-source.js';

/**
 * stampV3LayerSource runs after an import commits, while field edits
 * may be bumping a layer's syncVersion. These specs pin the write
 * discipline: lock the row, change only `source` on the named layer,
 * and keep every other key as the locked row has it.
 */
describe('stampV3LayerSource', () => {
  const SOURCE: V3LayerSourceStamp = {
    fileName: 'parcels.gdb.zip',
    format: 'gdb',
    sizeBytes: 1234,
    importedAt: '2026-11-08T00:00:00.000Z',
    importedBy: 'user-1',
    note: 'driver: OpenFileGDB',
    sourceSrs: 'EPSG:2227',
  };

  function prismaFor(lockedData: unknown) {
    const updates: unknown[] = [];
    const tx = {
      item: {
        update: jest.fn().mockImplementation((args: unknown) => {
          updates.push(args);
          return Promise.resolve({});
        }),
      },
      $queryRaw: jest.fn().mockResolvedValue(
        lockedData === undefined ? [] : [{ data: lockedData }],
      ),
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { prisma, tx, updates };
  }

  function writtenData(updates: unknown[]) {
    return (updates[0] as { data: { data: Record<string, unknown> } }).data.data;
  }

  it('re-reads the row under FOR UPDATE inside a transaction', async () => {
    const { prisma, tx } = prismaFor({ version: 3, layers: [{ id: 'parcels' }] });
    expect(await stampV3LayerSource(prisma as never, 'item-1', 'parcels', SOURCE)).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = (tx.$queryRaw.mock.calls[0]![0] as string[]).join('?');
    expect(sql).toMatch(/SELECT data_json AS data FROM item WHERE id = \?::uuid FOR UPDATE/);
  });

  it('keeps a syncVersion bumped before the stamp ran', async () => {
    const { prisma, updates } = prismaFor({
      version: 3,
      title: 'kept',
      layers: [
        { id: 'parcels', geometryType: 'polygon', syncVersion: 5, featureCount: 9 },
        { id: 'roads', geometryType: 'line', syncVersion: 2 },
      ],
    });
    expect(await stampV3LayerSource(prisma as never, 'item-1', 'parcels', SOURCE)).toBe(true);
    const data = writtenData(updates);
    expect(data.title).toBe('kept');
    const layers = data.layers as Array<Record<string, unknown>>;
    expect(layers[0]).toEqual({
      id: 'parcels',
      geometryType: 'polygon',
      syncVersion: 5,
      featureCount: 9,
      source: SOURCE,
    });
    expect(layers[1]).toEqual({ id: 'roads', geometryType: 'line', syncVersion: 2 });
  });

  it('leaves non-v3 items alone', async () => {
    const { prisma, tx } = prismaFor({ version: 2, layers: [{ id: 'parcels' }] });
    expect(await stampV3LayerSource(prisma as never, 'item-1', 'parcels', SOURCE)).toBe(false);
    expect(tx.item.update).not.toHaveBeenCalled();
  });

  it('does not write for a missing item or an unknown layer', async () => {
    const missing = prismaFor(undefined);
    expect(await stampV3LayerSource(missing.prisma as never, 'item-1', 'parcels', SOURCE)).toBe(false);
    expect(missing.tx.item.update).not.toHaveBeenCalled();

    const unknown = prismaFor({ version: 3, layers: [{ id: 'roads' }] });
    expect(await stampV3LayerSource(unknown.prisma as never, 'item-1', 'parcels', SOURCE)).toBe(false);
    expect(unknown.tx.item.update).not.toHaveBeenCalled();
  });
});
