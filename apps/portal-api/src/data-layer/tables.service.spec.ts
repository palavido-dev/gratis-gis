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
  }) {
    const updates: unknown[] = [];
    const prisma = {
      item: {
        findUnique: jest.fn().mockResolvedValue({ data: overrides.data }),
        update: jest.fn().mockImplementation((args: unknown) => {
          updates.push(args);
          return Promise.resolve({});
        }),
      },
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
});
