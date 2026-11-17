// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Read and save paths of DerivedLayersService that need the chain:
// enrich must see the step's real input, a bbox must not cut rows away
// from a whole-set tool, the leaf pad must cover every level's reach,
// and a two-input tool's other layer is pinned to a real sublayer.

import type { Item } from '@prisma/client';
import type { DerivedLayerData, FeatureField } from '@gratis-gis/shared-types';

import { DerivedLayersService } from './derived-layers.service.js';

const NUM: FeatureField = { name: 'r', label: 'r', type: 'number', nullable: true };
const LEAF = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function v3(id: string, layerIds: string[]) {
  return {
    id,
    type: 'data_layer',
    deletedAt: null,
    bbox: [0, 0, 1, 1],
    data: {
      version: 3,
      storageType: 'postgis',
      layers: layerIds.map((l) => ({ id: l, geometryType: 'point', fields: [NUM] })),
    },
  };
}

function parent(pipeline: DerivedLayerData['pipeline']) {
  const data: DerivedLayerData = {
    version: 1,
    source: { kind: 'data_layer', itemId: LEAF, layerKey: 'pts' },
    pipeline,
    featureLimit: 100,
    outputSchema: [NUM],
    bbox: [0, 0, 1, 1],
  };
  return { id: PARENT, type: 'derived_layer', deletedAt: null, bbox: [0, 0, 1, 1], data };
}

function svcWith(items: Record<string, unknown>) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const prisma = {
    item: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => items[where.id] ?? null),
      findFirst: jest.fn(async () => null),
    },
    $queryRawUnsafe: jest.fn(async (s: string, ...p: unknown[]) => {
      sql.push(s);
      params.push(p);
      return [{ max_value: 40 }];
    }),
  };
  return { svc: new DerivedLayersService(prisma as never), sql, params };
}

describe('enrich sees the step input', () => {
  it('buffer by field over a derived source reads the parent pipeline, not an empty table', async () => {
    const p = parent([{ tool: 'filter', params: { expression: "{{r}} > 1" } }]);
    const { svc, sql, params } = svcWith({ [LEAF]: v3(LEAF, ['pts']), [PARENT]: p });
    const out = await svc.validateAndEnrich(
      {
        version: 1,
        source: { kind: 'derived_layer', itemId: PARENT },
        pipeline: [{ tool: 'buffer', params: { mode: 'field', field: 'r', unit: 'meters' } }],
      },
      p as unknown as Item,
    );
    const step = out.pipeline[0]!;
    expect(step.tool === 'buffer' && step.params.mode === 'field' && step.params.cachedMaxMeters).toBe(40);
    expect(sql[0]).toContain('d1_step_1');
    expect(sql[0]).not.toContain('WHERE FALSE');
    // The field name binds after the parent's own parameters.
    expect(params[0]![params[0]!.length - 1]).toBe('r');
  });
});

describe('bbox on a read', () => {
  it('goes on the output when the pipeline has a whole-set step', async () => {
    const { svc, sql, params } = svcWith({ [LEAF]: v3(LEAF, ['pts']) });
    const item = {
      id: 'x',
      data: {
        version: 1,
        source: { kind: 'data_layer', itemId: LEAF, layerKey: 'pts' },
        pipeline: [{ tool: 'aggregate', params: { groupBy: [], aggs: [{ op: 'count', outputName: 'n' }] } }],
        featureLimit: 10,
        outputSchema: [],
        bbox: [],
      },
    } as unknown as Item;
    await svc.getGeoJson(item, v3(LEAF, ['pts']) as never, { bbox: [0, 0, 1, 1] });
    const [cteSql, finalSql] = sql[0]!.split(/SELECT global_id, ST_AsGeoJSON/);
    expect(cteSql).not.toContain('ST_MakeEnvelope');
    expect(finalSql).toContain('ST_MakeEnvelope');
    expect(params[0]!.slice(-5, -1)).toEqual([0, 0, 1, 1]);
  });

  it('pads the leaf by the reach of every level in a chain', async () => {
    const p = parent([{ tool: 'filter', params: { expression: "{{r}} > 1" } }]);
    const { svc, params } = svcWith({ [LEAF]: v3(LEAF, ['pts']), [PARENT]: p });
    const item = {
      id: 'c',
      data: {
        version: 1,
        source: { kind: 'derived_layer', itemId: PARENT },
        pipeline: [{ tool: 'buffer', params: { mode: 'fixed', distance: 11132, unit: 'meters' } }],
        featureLimit: 10,
        outputSchema: [NUM],
        bbox: [],
      },
    } as unknown as Item;
    await svc.getGeoJson(item, p as never, { bbox: [0, 0, 1, 1] });
    // The first four parameters are the leaf envelope.
    const [minX, minY] = params[0]! as number[];
    expect(minY).toBeCloseTo(-0.1, 5);
    expect(minX).toBeLessThan(-0.1);
  });
});

describe('two-input tools on save', () => {
  it('pins a missing otherSource layerKey to the only sublayer', async () => {
    const { svc } = svcWith({ [OTHER]: v3(OTHER, ['bounds']) });
    const out = await svc.validateAndEnrich(
      {
        version: 1,
        source: { kind: 'data_layer', itemId: LEAF, layerKey: 'pts' },
        pipeline: [{ tool: 'clip', params: { otherSource: { kind: 'data_layer', itemId: OTHER } } }],
      },
      v3(LEAF, ['pts']) as unknown as Item,
    );
    expect((out.pipeline[0]!.params as { otherSource: { layerKey?: string } }).otherSource.layerKey).toBe('bounds');
  });

  it('refuses a misspelled otherSource layerKey', async () => {
    const { svc } = svcWith({ [OTHER]: v3(OTHER, ['bounds', 'roads']) });
    await expect(
      svc.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'data_layer', itemId: LEAF, layerKey: 'pts' },
          pipeline: [
            { tool: 'clip', params: { otherSource: { kind: 'data_layer', itemId: OTHER, layerKey: 'bonds' } } },
          ],
        },
        v3(LEAF, ['pts']) as unknown as Item,
      ),
    ).rejects.toThrow(/otherSource/);
  });
});
