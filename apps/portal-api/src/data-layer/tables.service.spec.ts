// SPDX-License-Identifier: AGPL-3.0-or-later
import { DataLayerTablesService } from './tables.service.js';

/**
 * stampFeatureCounts is what keeps `data.layers[].featureCount`
 * honest, and that field decides a client-visible default (the QGIS
 * plugin opens small layers as true feature layers and keeps huge
 * ones on tiles). These specs pin the write discipline: stamp only
 * v3 items, only when a count actually changed, and never touch
 * layers the count query cannot address.
 */
describe('DataLayerTablesService.stampFeatureCounts', () => {
  function service(overrides: {
    data: unknown;
    counts?: Record<string, number>;
    /** What the row holds by the time the locked re-read runs. */
    lockedData?: unknown;
  }) {
    const updates: unknown[] = [];
    const item = {
      findUnique: jest.fn().mockResolvedValue({ data: overrides.data }),
      update: jest.fn().mockImplementation((args: unknown) => {
        updates.push(args);
        return Promise.resolve({});
      }),
    };
    const tx = {
      item,
      $queryRaw: jest.fn().mockResolvedValue([
        { data: 'lockedData' in overrides ? overrides.lockedData : overrides.data },
      ]),
    };
    const prisma = {
      item,
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      $queryRawUnsafe: jest.fn().mockImplementation((_sql: string, scope: string) => {
        const layerId = String(scope).split(':')[2] ?? '';
        const count = overrides.counts?.[layerId] ?? 0;
        return Promise.resolve([{ count: BigInt(count) }]);
      }),
    };
    const svc = new DataLayerTablesService(prisma as never);
    return { svc, prisma, updates };
  }

  it('stamps every layer with its live count', async () => {
    const { svc, updates } = service({
      data: {
        version: 3,
        layers: [
          { id: 'parcels', geometryType: 'polygon' },
          { id: 'summary', geometryType: null },
        ],
      },
      counts: { parcels: 1200, summary: 7 },
    });
    const changed = await svc.stampFeatureCounts('item-1');
    expect(changed).toBe(true);
    const written = (updates[0] as { data: { data: { layers: Array<Record<string, unknown>> } } })
      .data.data.layers;
    expect(written[0]?.featureCount).toBe(1200);
    expect(written[1]?.featureCount).toBe(7);
  });

  it('does not write when nothing changed', async () => {
    const { svc, prisma } = service({
      data: {
        version: 3,
        layers: [{ id: 'parcels', geometryType: 'polygon', featureCount: 5 }],
      },
      counts: { parcels: 5 },
    });
    expect(await svc.stampFeatureCounts('item-1')).toBe(false);
    expect(prisma.item.update).not.toHaveBeenCalled();
  });

  it('leaves non-v3 items alone', async () => {
    const { svc, prisma } = service({
      data: { version: 1, features: [] },
    });
    expect(await svc.stampFeatureCounts('item-1')).toBe(false);
    expect(prisma.item.update).not.toHaveBeenCalled();
  });

  it('skips layers with no id and keeps them verbatim', async () => {
    const { svc, updates } = service({
      data: {
        version: 3,
        layers: [{ geometryType: 'polygon' }, { id: 'ok', geometryType: 'point' }],
      },
      counts: { ok: 3 },
    });
    expect(await svc.stampFeatureCounts('item-1')).toBe(true);
    const written = (updates[0] as { data: { data: { layers: Array<Record<string, unknown>> } } })
      .data.data.layers;
    expect(written[0]).toEqual({ geometryType: 'polygon' });
    expect(written[1]?.featureCount).toBe(3);
  });

  it('keeps a syncVersion bumped while it was counting', async () => {
    const { svc, updates } = service({
      data: {
        version: 3,
        layers: [{ id: 'parcels', geometryType: 'polygon', syncVersion: 4 }],
      },
      lockedData: {
        version: 3,
        layers: [{ id: 'parcels', geometryType: 'polygon', syncVersion: 5 }],
      },
      counts: { parcels: 9 },
    });
    expect(await svc.stampFeatureCounts('item-1')).toBe(true);
    const written = (updates[0] as { data: { data: { layers: Array<Record<string, unknown>> } } })
      .data.data.layers;
    expect(written[0]).toMatchObject({ syncVersion: 5, featureCount: 9 });
  });
});

/**
 * truncateLayer deleted a layer's whole observation scope with no
 * tombstones and no syncVersion bump, so a delta client would keep
 * every row the server no longer had. Nothing called it any more
 * (replace imports go through CopyWriter.deleteScope and
 * commitCopiedLayer), so it is gone rather than left for a future
 * caller to wire back in.
 */
describe('DataLayerTablesService scope wipe', () => {
  it('has no method that deletes a scope behind the sync cursor', () => {
    expect(
      (DataLayerTablesService.prototype as unknown as Record<string, unknown>)
        .truncateLayer,
    ).toBeUndefined();
  });
});
