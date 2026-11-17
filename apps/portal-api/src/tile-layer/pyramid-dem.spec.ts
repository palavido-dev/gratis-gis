// SPDX-License-Identifier: AGPL-3.0-or-later
import { TileLayerPyramidWorker } from './pyramid.worker.js';

/**
 * A dem tile layer that reaches 'cog-ready' is claimed like any other
 * row, which flips it to 'tiling'. The worker must put it back to
 * 'ready' itself; returning without a terminal state left the row in
 * 'tiling' until reclaim re-armed it three times and reported a crash.
 */
describe('pyramid worker on a dem item', () => {
  it('stamps ready without downloading the COG', async () => {
    const sql: string[] = [];
    const values: unknown[][] = [];
    const prisma = {
      $executeRaw: jest.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
        sql.push(strings.join('?'));
        values.push(vals);
        return Promise.resolve(1);
      }),
    };
    const storage = { streamObjectToDisk: jest.fn() };
    const worker = new TileLayerPyramidWorker(prisma as never, storage as never);
    await (
      worker as unknown as {
        buildPyramid(c: { itemId: string; data: unknown }): Promise<void>;
      }
    ).buildPyramid({
      itemId: '00000000-0000-0000-0000-000000000001',
      data: {
        dem: true,
        processingState: 'tiling',
        cogStorageKey: 'item-tile-layer/dem.tif',
      },
    });
    expect(storage.streamObjectToDisk).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(values[0]).toContainEqual({ processingState: 'ready' });
    // The stamp is gated on the claim, like every other terminal write.
    expect(sql[0]).toContain(`'processingState' = 'tiling'`);
    expect(sql[1]).toContain(`'tilingError'`);
  });
});
