// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DataLayerTablesService } from '../data-layer/tables.service.js';
import { ItemBboxRefreshService } from './item-bbox-refresh.service.js';

/**
 * The write path bbox refresh. What matters here is WHICH path a
 * write takes: the arithmetic union (no observation table read) or
 * the full ST_Extent collapse. The collapse is the expensive query a
 * sustained edit session used to pay once a minute per replica, so
 * every case pins whether `aggregateBbox` ran.
 */

type Bbox = [number, number, number, number];

interface Row {
  id: string;
  type: string;
  data: unknown;
  bbox: unknown;
  deletedAt?: Date | null;
}

const LAYER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MAP = '33333333-3333-4333-8333-333333333333';
const MAP2 = '44444444-4444-4444-8444-444444444444';
const EDITOR = '55555555-5555-4555-8555-555555555555';

const FROM_ENGINE: Bbox = [-1, -1, 1, 1];

function point(x: number, y: number): unknown {
  return { type: 'Point', coordinates: [x, y] };
}

function pick(row: Row, select: Record<string, boolean> | undefined): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  const source = row as unknown as Record<string, unknown>;
  for (const key of Object.keys(select)) out[key] = source[key];
  return out;
}

/**
 * In memory stand in for the item table plus a reverse reference
 * oracle. The `$queryRaw` double answers the containment query by
 * looking for the target ids inside the bound JSON shapes, which is
 * what the real predicates carry, so a test that forgets to declare
 * a reference gets no cascade rather than a false positive.
 */
function makeWorld(rows: Row[], refs: Record<string, string[]>) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const findUnique = jest.fn(
    async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = byId.get(args.where.id);
      return row ? pick(row, args.select) : null;
    },
  );
  const findMany = jest.fn(
    async (args: {
      where: { id: { in: string[] }; deletedAt?: null };
      select?: Record<string, boolean>;
    }) =>
      rows
        .filter(
          (r) =>
            args.where.id.in.includes(r.id) &&
            (args.where.deletedAt === undefined || r.deletedAt == null),
        )
        .map((r) => pick(r, args.select)),
  );
  const update = jest.fn(
    async (args: { where: { id: string }; data: { bbox: unknown } }) => {
      const row = byId.get(args.where.id);
      if (row) row.bbox = args.data.bbox;
      return {};
    },
  );
  const $queryRaw = jest.fn(async (sql: { values: unknown[]; strings: string[] }) => {
    const out = new Set<string>();
    for (const [target, referencers] of Object.entries(refs)) {
      const asked = sql.values.some(
        (v) => typeof v === 'string' && v.includes(target),
      );
      if (asked) for (const id of referencers) out.add(id);
    }
    return Array.from(out).map((id) => ({ id }));
  });
  const aggregateBbox = jest.fn(async (): Promise<Bbox | null> => FROM_ENGINE);
  const service = new ItemBboxRefreshService(
    { item: { findUnique, findMany, update }, $queryRaw } as unknown as PrismaService,
    { aggregateBbox } as unknown as DataLayerTablesService,
  );
  const bboxOf = (id: string) => byId.get(id)?.bbox;
  const updatesFor = (id: string) =>
    update.mock.calls.filter((c) => c[0].where.id === id).length;
  return { service, findUnique, findMany, update, $queryRaw, aggregateBbox, bboxOf, updatesFor };
}

function standardRows(layerBbox: unknown = [0, 0, 10, 10]): Row[] {
  return [
    {
      id: LAYER,
      type: 'data_layer',
      data: { version: 3, layers: [{ id: 'a', geometryType: 'point', fields: [] }] },
      bbox: layerBbox,
    },
    { id: OTHER, type: 'data_layer', data: { version: 3, layers: [] }, bbox: [2, 2, 5, 5] },
    {
      id: MAP,
      type: 'map',
      data: {
        layers: [
          { source: { kind: 'data-layer', itemId: LAYER } },
          { source: { kind: 'data-layer', itemId: OTHER } },
        ],
      },
      bbox: [0, 0, 10, 10],
    },
    {
      id: EDITOR,
      type: 'web_app',
      data: {
        template: 'editor',
        config: { editor: { mapId: MAP, targets: [{ dataLayerId: LAYER }] } },
      },
      bbox: [0, 0, 10, 10],
    },
  ];
}

const STANDARD_REFS = { [LAYER]: [MAP], [MAP]: [EDITOR] };

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ItemBboxRefreshService: choosing the path', () => {
  it('an insert grows the bbox arithmetically and cascades, without the collapse', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, {
      kind: 'insert',
      geometries: [point(20, 5), null, point(3, -4)],
    });
    await w.service.flushPending(LAYER);

    expect(w.aggregateBbox).not.toHaveBeenCalled();
    expect(w.bboxOf(LAYER)).toEqual([0, -4, 20, 10]);
    expect(w.bboxOf(MAP)).toEqual([0, -4, 20, 10]);
    expect(w.bboxOf(EDITOR)).toEqual([0, -4, 20, 10]);
    // Only the bbox column is read to decide the path; the seed's
    // data_json is never loaded on the arithmetic path.
    expect(w.findUnique).toHaveBeenCalledTimes(1);
    expect(w.findUnique.mock.calls[0]![0].select).toEqual({ bbox: true });
  });

  it('an insert into a layer with no bbox yet falls back to the full recompute', async () => {
    const w = makeWorld(standardRows([]), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await w.service.flushPending(LAYER);

    expect(w.aggregateBbox).toHaveBeenCalledTimes(1);
    expect(w.bboxOf(LAYER)).toEqual(FROM_ENGINE);
    expect(w.bboxOf(MAP)).toEqual([-1, -1, 5, 5]);
  });

  it('an insert whose envelope is already inside the bbox writes nothing', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(5, 5)] });
    await w.service.flushPending(LAYER);

    expect(w.aggregateBbox).not.toHaveBeenCalled();
    expect(w.update).not.toHaveBeenCalled();
    expect(w.$queryRaw).not.toHaveBeenCalled();
  });

  it('an attribute only update never reaches the database', () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    const geometries = [point(10, 5), point(1, 1)];
    w.service.noteFeatureWrite(LAYER, {
      kind: 'update',
      before: geometries,
      after: geometries,
    });
    expect(w.service.hasPending(LAYER)).toBe(false);
    expect(w.findUnique).not.toHaveBeenCalled();
  });

  it('rows without geometry never touch the extent', () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [null, undefined] });
    w.service.noteFeatureWrite(LAYER, { kind: 'delete', geometries: [null] });
    expect(w.service.hasPending(LAYER)).toBe(false);
    expect(w.findUnique).not.toHaveBeenCalled();
  });

  it('deleting a feature strictly inside the bbox is skipped', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'delete', geometries: [point(5, 5)] });
    await w.service.flushPending(LAYER);

    expect(w.findUnique).toHaveBeenCalledTimes(1);
    expect(w.aggregateBbox).not.toHaveBeenCalled();
    expect(w.update).not.toHaveBeenCalled();
  });

  it('deleting a feature that touches an edge runs the full recompute', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'delete', geometries: [point(10, 5)] });
    await w.service.flushPending(LAYER);

    expect(w.aggregateBbox).toHaveBeenCalledTimes(1);
    expect(w.bboxOf(LAYER)).toEqual(FROM_ENGINE);
    expect(w.bboxOf(MAP)).toEqual([-1, -1, 5, 5]);
    expect(w.bboxOf(EDITOR)).toEqual([-1, -1, 5, 5]);
  });

  it('moving a feature from inside the bbox to outside it is a pure union', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, {
      kind: 'update',
      before: [point(1, 1)],
      after: [point(15, 1)],
    });
    await w.service.flushPending(LAYER);

    expect(w.aggregateBbox).not.toHaveBeenCalled();
    expect(w.bboxOf(LAYER)).toEqual([0, 0, 15, 10]);
  });

  it('moving a feature off an edge needs the recompute even if it lands inside', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, {
      kind: 'update',
      before: [point(0, 5)],
      after: [point(5, 5)],
    });
    await w.service.flushPending(LAYER);

    expect(w.aggregateBbox).toHaveBeenCalledTimes(1);
  });

  it('refreshItemBbox forces the recompute regardless of geometry', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.refreshItemBbox(LAYER);
    await w.service.flushPending(LAYER);
    expect(w.aggregateBbox).toHaveBeenCalledTimes(1);
  });

  it('an item purged before the flush is a no-op, not an error', async () => {
    const w = makeWorld([], {});
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await expect(w.service.flushPending(LAYER)).resolves.toBeUndefined();
    expect(w.update).not.toHaveBeenCalled();
  });

  it('a failing recompute is logged, not thrown, and clears the in flight slot', async () => {
    const w = makeWorld(standardRows([]), STANDARD_REFS);
    w.aggregateBbox.mockRejectedValueOnce(new Error('pool exhausted'));
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await expect(w.service.flushPending(LAYER)).resolves.toBeUndefined();
    expect(w.update).not.toHaveBeenCalled();
    expect(w.service.hasPending(LAYER)).toBe(false);
  });
});

describe('ItemBboxRefreshService: coalescing', () => {
  it('flushes the first write at once, merges the rest, and flushes their union when the window closes', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);

    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await w.service.flushPending(LAYER);
    expect(w.bboxOf(LAYER)).toEqual([0, 0, 20, 10]);
    expect(w.updatesFor(LAYER)).toBe(1);

    // Inside the window: nothing is written, everything is kept.
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(30, 5)] });
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(5, -8)] });
    expect(w.service.hasPending(LAYER)).toBe(true);
    jest.advanceTimersByTime(59_999);
    await Promise.resolve();
    expect(w.updatesFor(LAYER)).toBe(1);
    expect(w.service.hasPending(LAYER)).toBe(true);

    jest.advanceTimersByTime(1);
    await w.service.flushPending(LAYER);
    expect(w.service.hasPending(LAYER)).toBe(false);
    expect(w.updatesFor(LAYER)).toBe(2);
    expect(w.bboxOf(LAYER)).toEqual([0, -8, 30, 10]);
    expect(w.bboxOf(EDITOR)).toEqual([0, -8, 30, 10]);
    expect(w.aggregateBbox).not.toHaveBeenCalled();
  });

  it('a recompute owed inside the window wins over the pending union', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await w.service.flushPending(LAYER);

    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(30, 5)] });
    w.service.noteFeatureWrite(LAYER, { kind: 'delete', geometries: [point(0, 5)] });
    jest.advanceTimersByTime(60_000);
    await w.service.flushPending(LAYER);

    expect(w.aggregateBbox).toHaveBeenCalledTimes(1);
    expect(w.bboxOf(LAYER)).toEqual(FROM_ENGINE);
  });

  it('a second quiet write after the window flushes immediately again', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await w.service.flushPending(LAYER);
    jest.advanceTimersByTime(60_000);

    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(-20, 5)] });
    expect(w.service.hasPending(LAYER)).toBe(false);
    await w.service.flushPending(LAYER);
    expect(w.bboxOf(LAYER)).toEqual([-20, 0, 20, 10]);
  });

  it('windows are per item', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await w.service.flushPending(LAYER);
    w.service.noteFeatureWrite(OTHER, { kind: 'insert', geometries: [point(20, 5)] });
    expect(w.service.hasPending(OTHER)).toBe(false);
    await w.service.flushPending(OTHER);
    expect(w.bboxOf(OTHER)).toEqual([2, 2, 20, 5]);
  });
});

describe('ItemBboxRefreshService: reverse reference walk', () => {
  it('loads each level in one findMany and asks Postgres for the referencers of the whole frontier', async () => {
    const rows = standardRows();
    rows.push({
      id: MAP2,
      type: 'map',
      data: { layers: [{ source: { kind: 'data-layer', itemId: LAYER } }] },
      bbox: [0, 0, 10, 10],
    });
    const w = makeWorld(rows, { [LAYER]: [MAP, MAP2], [MAP]: [EDITOR], [MAP2]: [EDITOR] });
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await w.service.flushPending(LAYER);

    // Level 1 (two maps) and level 2 (one editor): one findMany each,
    // the first carrying both ids. The referenced-but-not-refreshed
    // OTHER layer is read by the map aggregation, not by the walk.
    const walkLoads = w.findMany.mock.calls.filter(
      (c) => c[0].select && 'data' in c[0].select,
    );
    expect(walkLoads.map((c) => c[0].where.id.in.slice().sort())).toEqual([
      [MAP, MAP2].sort(),
      [EDITOR],
    ]);
    // Hop 1 asks about the seed, hop 2 about both maps at once; the
    // editor (hop 2) is not expanded further.
    expect(w.$queryRaw).toHaveBeenCalledTimes(2);
    const secondAsk = w.$queryRaw.mock.calls[1]![0].values.join('\n');
    expect(secondAsk).toContain(MAP);
    expect(secondAsk).toContain(MAP2);
    expect(w.bboxOf(MAP2)).toEqual([0, 0, 20, 10]);
    expect(w.bboxOf(EDITOR)).toEqual([0, 0, 20, 10]);
  });

  it('filters in Postgres with indexed containment over the bbox bearing shapes, in kebab enum spelling', async () => {
    const w = makeWorld(standardRows(), STANDARD_REFS);
    w.service.noteFeatureWrite(LAYER, { kind: 'insert', geometries: [point(20, 5)] });
    await w.service.flushPending(LAYER);

    const sql = w.$queryRaw.mock.calls[0]![0];
    const text = sql.strings.join('?');
    expect(text).toContain('data_json @>');
    expect(text).toContain(`'map'::"ItemType"`);
    expect(text).toContain(`'editor'::"ItemType"`);
    expect(text).toContain(`'web-app'::"ItemType"`);
    expect(text).toContain(`'derived-layer'::"ItemType"`);
    expect(text).not.toContain('web_app');
    expect(text).not.toContain('derived_layer');
    expect(text).toContain('deleted_at IS NULL');
    // Every bound value is a JSON shape naming the target: nothing
    // else is transferred and no data_json is selected.
    expect(text).toMatch(/SELECT id\s+FROM "item"/);
    const shapes = sql.values.map((v) => JSON.parse(v as string) as Record<string, unknown>);
    expect(shapes).toEqual(
      expect.arrayContaining([
        { layers: [{ source: { kind: 'data-layer', itemId: LAYER } }] },
        { layers: [{ source: { kind: 'arcgis-rest', sourceItemId: LAYER } }] },
        { mapId: LAYER },
        { targets: [{ dataLayerId: LAYER }] },
        { template: 'editor', config: { editor: { mapId: LAYER } } },
        { template: 'editor', config: { editor: { targets: [{ dataLayerId: LAYER }] } } },
        { source: { itemId: LAYER } },
      ]),
    );
    expect(shapes).toHaveLength(7);
  });
});
