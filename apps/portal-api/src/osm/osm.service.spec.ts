// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OsmService and OverpassClient behaviour that used to go wrong
// silently: a small-limit call poisoning the cache for larger ones,
// Overpass runtime errors cached as empty answers, one insert per
// feature, features that left OSM staying in a re-resolved scope,
// cache hits with different ids than misses, relational sets told
// apart by tags, and client aborts shorter than the query's own
// timeout.

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('./preset-catalog.js', () => {
  const presets: Record<string, unknown> = {
    cafe: { id: 'cafe', label: 'Cafe', category: 'x', tags: [{ key: 'amenity', value: 'cafe' }], geometries: ['node'] },
    school: { id: 'school', label: 'School', category: 'x', tags: [{ key: 'amenity', value: 'school' }], geometries: ['node'] },
    park: { id: 'park', label: 'Park', category: 'x', tags: [{ key: 'leisure', value: 'park' }], geometries: ['node'] },
  };
  return {
    getOsmPresets: jest.fn(async (ids: string[]) => ids.map((id) => presets[id])),
    getOsmPreset: jest.fn(async (id: string) => presets[id]),
  };
});

import { OsmService } from './osm.service.js';
import { OverpassClient } from './overpass-client.js';
import { buildRelationalOverpassQl } from './overpass-ql.js';

function node(id: number, tags: Record<string, string>) {
  return { type: 'node', id, lat: 1, lon: 1, tags };
}

function cafes(n: number) {
  return Array.from({ length: n }, (_, i) => node(i + 1, { amenity: 'cafe' }));
}

function makeService(opts: { elements?: unknown[]; previousEntities?: string[] } = {}) {
  const cache = new Map<string, { scope: string; featureCount: number; expiresAt: Date }>();
  const prisma = {
    organization: { findUnique: jest.fn(async () => null) },
    osmQueryCache: {
      findUnique: jest.fn(async ({ where }: { where: { hash: string } }) => cache.get(where.hash) ?? null),
      upsert: jest.fn(async ({ where, create }: { where: { hash: string }; create: { scope: string; featureCount: number; expiresAt: Date } }) => {
        cache.set(where.hash, create);
      }),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('SELECT DISTINCT entity')) {
        return (opts.previousEntities ?? []).map((entity) => ({ entity }));
      }
      // readFeaturesFromScope
      return [
        {
          entity: '00000000-0000-4000-8000-000000000001',
          geom: '{"type":"Point","coordinates":[1,1]}',
          attrs: { osmType: 'node', osmId: 7, amenity: 'cafe' },
        },
      ];
    }),
  };
  const engine = { write: jest.fn(), writeMany: jest.fn(async (rows: unknown[]) => rows) };
  const client = { run: jest.fn(async () => ({ elements: opts.elements ?? cafes(300) })) };
  const svc = new OsmService(prisma as never, engine as never, client as never);
  return { svc, prisma, engine, client, cache };
}

const BBOX: [number, number, number, number] = [0, 0, 0.1, 0.1];

describe('OsmService.resolve cache', () => {
  it('a small-limit call does not answer a later larger-limit call', async () => {
    const { svc, client } = makeService();
    const small = await svc.resolve({ presetIds: ['cafe'], bbox: BBOX, maxFeatures: 10 });
    expect(small.features).toHaveLength(10);
    expect(small.featureCount).toBe(300);
    const big = await svc.resolve({ presetIds: ['cafe'], bbox: BBOX, maxFeatures: 5000 });
    expect(big.cacheHit).toBe(false);
    expect(big.features).toHaveLength(300);
    expect(client.run).toHaveBeenCalledTimes(2);
  });

  it('a cache hit reports the raw count so truncation still shows', async () => {
    const { svc } = makeService();
    await svc.resolve({ presetIds: ['cafe'], bbox: BBOX, maxFeatures: 10 });
    const hit = await svc.resolve({ presetIds: ['cafe'], bbox: BBOX, maxFeatures: 10 });
    expect(hit.cacheHit).toBe(true);
    expect(hit.featureCount).toBe(300);
  });

  it('a cache hit returns the same node/123 ids a miss does', async () => {
    const { svc } = makeService();
    await svc.resolve({ presetIds: ['cafe'], bbox: BBOX, maxFeatures: 10 });
    const hit = await svc.resolve({ presetIds: ['cafe'], bbox: BBOX, maxFeatures: 10 });
    expect(hit.features[0]!.id).toBe('node/7');
  });

  it('writes the features in one batched call and tombstones ones that left the result', async () => {
    const stale = '00000000-0000-4000-8000-0000000000ff';
    const { svc, engine } = makeService({ elements: cafes(3), previousEntities: [stale] });
    await svc.resolve({ presetIds: ['cafe'], bbox: BBOX, maxFeatures: 10 });
    expect(engine.write).not.toHaveBeenCalled();
    expect(engine.writeMany).toHaveBeenCalledTimes(1);
    const rows = engine.writeMany.mock.calls[0]![0] as Array<{ kind: string; entity: string }>;
    expect(rows.filter((r) => r.kind === 'create')).toHaveLength(3);
    expect(rows.filter((r) => r.kind === 'delete').map((r) => r.entity)).toEqual([stale]);
  });

  it('gives the client longer than the query tells Overpass to run', async () => {
    const { svc, client } = makeService();
    await svc.resolve({ presetIds: ['cafe'], bbox: BBOX, maxFeatures: 10 });
    const ql = (client.run.mock.calls[0] as unknown as [{ ql: string; timeoutMs: number }])[0];
    const qlSeconds = Number(/\[timeout:(\d+)\]/.exec(ql.ql)![1]);
    expect(ql.timeoutMs).toBeGreaterThan(qlSeconds * 1000);
    // maxsize is a memory budget, not the feature limit times 1 KiB.
    expect(ql.ql).not.toMatch(/\[maxsize:10240\]/);
  });
});

describe('OsmService.resolveRelational', () => {
  it('splits sets on the count markers, even when a supporting feature matches the anchor preset', async () => {
    // A school that is also a supporting feature of condition 0 (both
    // conditions use the same preset). By tags alone it was filed as
    // an anchor and condition 1 got nothing.
    const count = { type: 'count', id: 0, tags: { total: '1' } };
    const elements = [
      count,
      node(1, { amenity: 'school' }),
      count,
      node(2, { leisure: 'park' }),
      count,
      node(2, { leisure: 'park' }),
    ];
    const { svc, client } = makeService({ elements });
    const res = await svc.resolveRelational({
      anchorPresetId: 'school',
      conditions: [
        { presetId: 'park', distanceMeters: 500 },
        { presetId: 'park', distanceMeters: 800 },
      ],
      bbox: BBOX,
    });
    expect(res.anchor.features.map((f) => f.id)).toEqual(['node/1']);
    expect(res.conditions.map((c) => c.supportingCount)).toEqual([1, 1]);
    const call = (client.run.mock.calls[0] as unknown as [{ timeoutMs: number }])[0];
    expect(call.timeoutMs).toBeGreaterThan(60_000);
  });

  it('takes survivors from the anchors found inside the bbox', () => {
    const preset = { id: 'school', label: 'S', category: 'x', tags: [{ key: 'amenity', value: 'school' }], geometries: ['node' as const, 'way' as const] };
    const park = { ...preset, id: 'park', tags: [{ key: 'leisure', value: 'park' }] };
    const ql = buildRelationalOverpassQl({
      anchor: preset,
      conditions: [{ preset: park, distanceMeters: 500 }],
      bbox: BBOX,
    });
    expect(ql).toContain('node.anchors(around.cond0:500);');
    expect(ql).toContain('way.anchors(around.cond0:500);');
    expect(ql).toMatch(/\.survivors out count;/);
  });
});

describe('OverpassClient', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('treats an HTTP 200 runtime error remark as a failure', async () => {
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query run out of memory using about 10 MB of RAM.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as never;
    await expect(
      new OverpassClient().run({ endpoint: 'https://overpass.example/api/interpreter', ql: 'x' }),
    ).rejects.toThrow(/Overpass rejected the query/);
  });
});
