// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ObservationValidationError,
  type Observation,
  isUuid,
  uuidv7,
} from '@gratis-gis/engine';

import { EngineService } from './engine.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Minimal fake PrismaService that records `$executeRaw`,
 * `$executeRawUnsafe`, and `$queryRaw` invocations without touching a
 * real database.
 */
function makeFakePrisma() {
  const writes: Array<{ values: unknown[] }> = [];
  const unsafeWrites: Array<{ sql: string; values: unknown[] }> = [];
  return {
    writes,
    unsafeWrites,
    fake: {
      async $executeRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
        writes.push({ values });
        return 1;
      },
      async $executeRawUnsafe(sql: string, ...values: unknown[]) {
        unsafeWrites.push({ sql, values });
        return 1;
      },
      async $queryRaw(_strings: TemplateStringsArray, ..._values: unknown[]) {
        return [];
      },
    } as unknown as PrismaService,
  };
}

function fixture(overrides: Partial<Observation> = {}): Observation {
  return {
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    scope: 'data_layer:test',
    entity: uuidv7(),
    kind: 'create',
    attrs: { name: 'test' },
    geom: { type: 'Point', coordinates: [-111.65, 40.6] },
    author: { sub: 'user-123', displayName: 'Test User' },
    source: { kind: 'web' },
    parents: [],
    ...overrides,
  };
}

describe('EngineService.write', () => {
  it('fills in id, txTime, and cell when omitted', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const obs = await svc.write(fixture());
    expect(isUuid(obs.id ?? '')).toBe(true);
    expect(obs.txTime).toBeInstanceOf(Date);
    expect(obs.cell).toMatch(/^[0-9a-f]+$/);
  });

  it('preserves explicit id, txTime, and cell when provided', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const id = uuidv7();
    const txTime = new Date('2026-02-02T00:00:00Z');
    const obs = await svc.write(fixture({ id, txTime, cell: '871fb466cffffff' }));
    expect(obs.id).toBe(id);
    expect(obs.txTime).toEqual(txTime);
    expect(obs.cell).toBe('871fb466cffffff');
  });

  it('rejects observations that fail validation', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    await expect(
      svc.write(fixture({ entity: 'not-a-uuid' })),
    ).rejects.toBeInstanceOf(ObservationValidationError);
  });

  it('omits the cell when the geometry is null', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const obs = await svc.write(fixture({ geom: null }));
    expect(obs.cell).toBe(null);
  });

  it('issues exactly one $executeRaw call per write', async () => {
    const { writes, fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    await svc.write(fixture());
    expect(writes).toHaveLength(1);
  });
});

describe('EngineService.writeMany', () => {
  it('returns an empty array on empty input without hitting the DB', async () => {
    const { unsafeWrites, fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const out = await svc.writeMany([]);
    expect(out).toEqual([]);
    expect(unsafeWrites).toHaveLength(0);
  });

  it('fills id, txTime, and cell for each input', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const out = await svc.writeMany([fixture(), fixture(), fixture()]);
    expect(out).toHaveLength(3);
    for (const obs of out) {
      expect(isUuid(obs.id ?? '')).toBe(true);
      expect(obs.txTime).toBeInstanceOf(Date);
      expect(obs.cell).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('preserves input order in the returned array', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const labelled = [
      { ...fixture(), attrs: { i: 0 } },
      { ...fixture(), attrs: { i: 1 } },
      { ...fixture(), attrs: { i: 2 } },
    ];
    const out = await svc.writeMany(labelled);
    expect(out.map((o) => (o.attrs as { i: number }).i)).toEqual([0, 1, 2]);
  });

  it('issues one INSERT per WRITE_BATCH_SIZE chunk', async () => {
    const { unsafeWrites, fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    // WRITE_BATCH_SIZE is 2000 (bumped from 500 in #114 to cut DB
    // roundtrips). 4500 rows -> ceil(4500/2000) = 3 INSERT
    // statements. Inputs deliberately exceeds 2 * batch + 1 so we
    // cover both "full batch" and "partial-tail batch" shapes.
    const inputs = Array.from({ length: 4500 }, () => fixture());
    await svc.writeMany(inputs);
    expect(unsafeWrites).toHaveLength(3);
    // Spot-check the first chunk: 2000 rows * 13 params = 26000 bound values.
    expect(unsafeWrites[0]!.values).toHaveLength(2000 * 13);
    // Last chunk has the remaining 500 rows.
    expect(unsafeWrites[2]!.values).toHaveLength(500 * 13);
  });

  it('rejects the whole batch when one observation fails validation', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const bad = { ...fixture(), entity: 'not-a-uuid' };
    await expect(svc.writeMany([fixture(), bad])).rejects.toThrow();
  });
});

/**
 * DataLayerEngine drops its cached tiles and aggregates from this hook,
 * before the write returns, so a writer that reads back through the
 * same replica never sees the pre-write answer. A write path that
 * forgot to report would leave the cache stale for a full TTL on that
 * replica, and nothing but this would say so.
 */
describe('EngineService.onWrite', () => {
  it('tells listeners which scopes a single write landed in, before it returns', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const seen: Array<string[]> = [];
    svc.onWrite((scopes) => seen.push([...scopes].sort()));
    await svc.write(fixture({ scope: 'data_layer:a:1' }));
    expect(seen).toEqual([['data_layer:a:1']]);
  });

  it('collapses a batch to its distinct scopes and fires once per writeMany', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const seen: Array<string[]> = [];
    svc.onWrite((scopes) => seen.push([...scopes].sort()));
    await svc.writeMany([
      fixture({ scope: 'data_layer:a:1' }),
      fixture({ scope: 'data_layer:a:1' }),
      fixture({ scope: 'data_layer:b:2' }),
    ]);
    expect(seen).toEqual([['data_layer:a:1', 'data_layer:b:2']]);
  });

  it('fires every registered listener', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const first = jest.fn();
    const second = jest.fn();
    svc.onWrite(first);
    svc.onWrite(second);
    await svc.write(fixture());
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not fire for an empty writeMany or a failed validation', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const listener = jest.fn();
    svc.onWrite(listener);
    await svc.writeMany([]);
    await expect(svc.write(fixture({ entity: 'not-a-uuid' }))).rejects.toBeInstanceOf(
      ObservationValidationError,
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
