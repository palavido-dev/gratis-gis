// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pins the search-index reconciler's observable contract: the exact
// index names and DDL strings it emits (the planner only matches an
// index whose expression mirrors DataLayerEngine.searchFeatures'
// per-field arm, so the SQL text is load-bearing), the drop path for
// fields that stop being searchable, the invalid-index cleanup that
// must run before CREATE INDEX IF NOT EXISTS, and the refusal to
// drop anything we did not name ourselves.

import {
  DataLayerSearchIndexService,
  readSearchableLayers,
} from './search-index.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DataLayerLayerShape } from './tables.service.js';

const ITEM_ID = '11111111-1111-7111-8111-111111111111';
const LAYER_ID = 'layer-1';
const SCOPE = `data_layer:${ITEM_ID}:${LAYER_ID}`;

// Precomputed md5 halves. Hardcoded (not recomputed via crypto in
// the test) so an accidental change to the hash recipe fails loudly
// instead of the test recomputing itself into agreement.
const SCOPE_HASH = 'a92a2652d777b95a'; // md5(SCOPE).slice(0, 16)
const OWNER_HASH = 'de06d20060c639c5'; // md5('OWNER')
const OWNER_NAME_HASH = 'b7dbf2094628abee'; // md5('Owner Name')
const APN_HASH = '9e4f252eed3a6a6e'; // md5('APN')

/**
 * Prisma stand-in that answers the three raw reads the service does
 * (pg_indexes discovery, invalid-tree probe, orphan enumeration) and
 * records every raw DDL statement. Dispatch keys off distinctive
 * SQL fragments, not call order, so a reordering refactor cannot
 * silently green the suite.
 */
function makePrisma(state: {
  existing?: string[];
  invalid?: string[];
  allGgs?: string[];
  items?: Array<{ id: string; data: unknown }>;
}) {
  const executed: string[] = [];
  const prisma = {
    executed,
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
    $queryRaw: jest.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('$');
        if (text.includes('pg_inherits')) {
          const like = String(values[0] ?? '');
          return (state.invalid ?? [])
            .filter((n) => n.startsWith(like.replace(/%$/, '')))
            .map((indexname) => ({ indexname }));
        }
        if (text.includes('FROM pg_indexes')) {
          const like = String(values[0] ?? '');
          const prefix = like.replace(/%$/, '');
          const pool =
            prefix === 'idx_ggs_'
              ? (state.allGgs ?? [])
              : (state.existing ?? []);
          return pool
            .filter((n) => n.startsWith(prefix))
            .map((indexname) => ({ indexname }));
        }
        throw new Error(`Unexpected $queryRaw in test: ${text}`);
      },
    ),
    item: {
      findMany: jest.fn(async () => state.items ?? []),
    },
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

function layer(
  fields: Array<{ name: string; searchable?: boolean }>,
): DataLayerLayerShape {
  return {
    id: LAYER_ID,
    geometryType: 'polygon',
    fields: fields.map((f) => ({
      name: f.name,
      type: 'string' as const,
      ...(f.searchable === true ? { searchable: true } : {}),
    })),
  };
}

describe('index name generation', () => {
  it('is deterministic: prefix + scope hash + field hash', () => {
    expect(DataLayerSearchIndexService.indexName(SCOPE, 'OWNER')).toBe(
      `idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`,
    );
    expect(DataLayerSearchIndexService.indexName(SCOPE, 'Owner Name')).toBe(
      `idx_ggs_${SCOPE_HASH}_${OWNER_NAME_HASH}`,
    );
  });

  it('stays inside the 63-char identifier limit and matches its own validator', () => {
    const name = DataLayerSearchIndexService.indexName(
      `data_layer:${ITEM_ID}:a-very-long-layer-key-created-by-the-form-designer`,
      'An Extremely Long Field Name From A CSV Header Row That Goes On',
    );
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(DataLayerSearchIndexService.INDEX_NAME_RE);
  });

  it('collision-safe where the geocoder scheme is not: fields that sanitize alike hash apart', () => {
    const a = DataLayerSearchIndexService.indexName(SCOPE, 'Owner Name');
    const b = DataLayerSearchIndexService.indexName(SCOPE, 'Owner_Name');
    expect(a).not.toBe(b);
  });
});

describe('DDL generation (exact SQL: the planner matches this text against searchFeatures)', () => {
  it('emits the geocoder-shaped partial trigram CREATE INDEX', () => {
    const name = `idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`;
    expect(
      DataLayerSearchIndexService.createIndexSql(name, 'OWNER', SCOPE),
    ).toBe(
      `CREATE INDEX IF NOT EXISTS "idx_ggs_${SCOPE_HASH}_${OWNER_HASH}" ON observation ` +
        `USING gin ((attrs->>'OWNER') gin_trgm_ops) ` +
        `WHERE scope = 'data_layer:${ITEM_ID}:${LAYER_ID}'`,
    );
  });

  it('quote-doubles apostrophes in field names (CSV headers are arbitrary text)', () => {
    expect(
      DataLayerSearchIndexService.createIndexSql('idx_x', "Owner's Name", SCOPE),
    ).toBe(
      `CREATE INDEX IF NOT EXISTS "idx_x" ON observation ` +
        `USING gin ((attrs->>'Owner''s Name') gin_trgm_ops) ` +
        `WHERE scope = '${SCOPE}'`,
    );
  });

  it('quote-doubles the scope too, mirroring the geocoder', () => {
    expect(
      DataLayerSearchIndexService.createIndexSql(
        'idx_x',
        'F',
        "data_layer:it'em:layer",
      ),
    ).toContain(`WHERE scope = 'data_layer:it''em:layer'`);
  });

  it('emits DROP INDEX IF EXISTS with a quoted identifier', () => {
    expect(DataLayerSearchIndexService.dropIndexSql('idx_ggs_a_b')).toBe(
      'DROP INDEX IF EXISTS "idx_ggs_a_b"',
    );
  });
});

describe('unsafe field rejection', () => {
  it('rejects what quote-doubling cannot make safe, allows the rest', () => {
    expect(DataLayerSearchIndexService.unsafeFieldReason('')).toMatch(/empty/);
    expect(
      DataLayerSearchIndexService.unsafeFieldReason('a'.repeat(201)),
    ).toMatch(/longer/);
    expect(
      DataLayerSearchIndexService.unsafeFieldReason('bad\\slash'),
    ).toMatch(/backslash/);
    expect(
      DataLayerSearchIndexService.unsafeFieldReason('tab\there'),
    ).toMatch(/control/);
    expect(DataLayerSearchIndexService.unsafeFieldReason('OWNER')).toBeNull();
    expect(
      DataLayerSearchIndexService.unsafeFieldReason('Owner Name'),
    ).toBeNull();
    expect(
      DataLayerSearchIndexService.unsafeFieldReason("Owner's Name"),
    ).toBeNull();
  });
});

describe('reconcileItem', () => {
  it('creates an index per searchable field and none for the rest', async () => {
    const prisma = makePrisma({ existing: [] });
    const svc = new DataLayerSearchIndexService(prisma);
    const res = await svc.reconcileItem(ITEM_ID, [
      layer([
        { name: 'OWNER', searchable: true },
        { name: 'APN', searchable: true },
        { name: 'NOTES' }, // not searchable: no index
      ]),
    ]);
    expect(res.created).toEqual([
      `idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`,
      `idx_ggs_${SCOPE_HASH}_${APN_HASH}`,
    ]);
    expect(prisma.executed).toEqual([
      DataLayerSearchIndexService.createIndexSql(
        `idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`,
        'OWNER',
        SCOPE,
      ),
      DataLayerSearchIndexService.createIndexSql(
        `idx_ggs_${SCOPE_HASH}_${APN_HASH}`,
        'APN',
        SCOPE,
      ),
    ]);
    expect(res.dropped).toEqual([]);
    expect(res.kept).toEqual([]);
  });

  it('keeps current indexes and drops the one whose field is no longer searchable', async () => {
    const ownerIdx = `idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`;
    const apnIdx = `idx_ggs_${SCOPE_HASH}_${APN_HASH}`;
    const prisma = makePrisma({ existing: [ownerIdx, apnIdx] });
    const svc = new DataLayerSearchIndexService(prisma);
    // APN got unticked: only OWNER stays searchable.
    const res = await svc.reconcileItem(ITEM_ID, [
      layer([{ name: 'OWNER', searchable: true }, { name: 'APN' }]),
    ]);
    expect(res.kept).toEqual([ownerIdx]);
    expect(res.dropped).toEqual([apnIdx]);
    expect(res.created).toEqual([]);
    expect(prisma.executed).toEqual([
      `DROP INDEX IF EXISTS "${apnIdx}"`,
    ]);
  });

  it('drops every index under the scope when no field is searchable any more', async () => {
    const ownerIdx = `idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`;
    const apnIdx = `idx_ggs_${SCOPE_HASH}_${APN_HASH}`;
    const prisma = makePrisma({ existing: [ownerIdx, apnIdx] });
    const svc = new DataLayerSearchIndexService(prisma);
    const res = await svc.reconcileItem(ITEM_ID, [
      layer([{ name: 'OWNER' }, { name: 'APN' }]),
    ]);
    expect(new Set(res.dropped)).toEqual(new Set([ownerIdx, apnIdx]));
    expect(res.created).toEqual([]);
  });

  it('drops an invalid index tree first, then recreates it (IF NOT EXISTS would have kept the wreck)', async () => {
    const ownerIdx = `idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`;
    const prisma = makePrisma({
      existing: [ownerIdx],
      invalid: [ownerIdx],
    });
    const svc = new DataLayerSearchIndexService(prisma);
    const res = await svc.reconcileItem(ITEM_ID, [
      layer([{ name: 'OWNER', searchable: true }]),
    ]);
    expect(res.droppedInvalid).toEqual([ownerIdx]);
    expect(res.created).toEqual([ownerIdx]);
    expect(res.kept).toEqual([]);
    expect(prisma.executed).toEqual([
      `DROP INDEX IF EXISTS "${ownerIdx}"`,
      DataLayerSearchIndexService.createIndexSql(ownerIdx, 'OWNER', SCOPE),
    ]);
  });

  it('refuses to drop an index name that fails the self-minted pattern', async () => {
    // Shaped to survive the LIKE prefix filter but not the strict
    // validator (uppercase hex is not something we ever mint).
    const impostor = `idx_ggs_${SCOPE_HASH}_ZZZZZZZZZZZZZZZZ`;
    const prisma = makePrisma({ existing: [impostor] });
    const svc = new DataLayerSearchIndexService(prisma);
    const res = await svc.reconcileItem(ITEM_ID, [layer([])]);
    expect(res.dropped).toEqual([]);
    expect(prisma.executed).toEqual([]);
  });

  it('skips unindexable field names and says why, instead of emitting broken DDL', async () => {
    const prisma = makePrisma({ existing: [] });
    const svc = new DataLayerSearchIndexService(prisma);
    const res = await svc.reconcileItem(ITEM_ID, [
      layer([
        { name: 'back\\slash', searchable: true },
        { name: 'OWNER', searchable: true },
      ]),
    ]);
    expect(res.skippedFields).toEqual([
      {
        scope: SCOPE,
        field: 'back\\slash',
        reason: 'field name contains a backslash',
      },
    ]);
    expect(res.created).toEqual([`idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`]);
  });
});

describe('buildForOrg orphan sweep', () => {
  it('drops idx_ggs indexes whose scope hash matches no known layer, keeps the rest', async () => {
    const knownIdx = `idx_ggs_${SCOPE_HASH}_${OWNER_HASH}`;
    const orphanIdx = 'idx_ggs_0123456789abcdef_fedcba9876543210';
    const item = {
      id: ITEM_ID,
      data: {
        version: 3,
        layers: [
          {
            id: LAYER_ID,
            geometryType: 'polygon',
            fields: [{ name: 'OWNER', type: 'string', searchable: true }],
          },
        ],
      },
    };
    const prisma = makePrisma({
      existing: [knownIdx],
      allGgs: [knownIdx, orphanIdx],
      items: [item],
    });
    const svc = new DataLayerSearchIndexService(prisma);
    const res = await svc.buildForOrg('org-1');
    expect(res.kept).toEqual([knownIdx]);
    expect(res.orphansDropped).toEqual([orphanIdx]);
    expect(prisma.executed).toEqual([
      `DROP INDEX IF EXISTS "${orphanIdx}"`,
    ]);
    expect(res.scannedItems).toBe(1);
    expect(res.indexedLayers).toBe(1);
  });
});

describe('readSearchableLayers', () => {
  it('narrows a v3 payload to layer ids + fields + searchable flags', () => {
    const layers = readSearchableLayers({
      version: 3,
      layers: [
        {
          id: 'layer-1',
          geometryType: 'point',
          fields: [
            { name: 'OWNER', type: 'string', searchable: true },
            { name: 'NOTES', type: 'string', searchable: false },
            { name: '', type: 'string', searchable: true }, // dropped
          ],
        },
      ],
    });
    expect(layers).toEqual([
      {
        id: 'layer-1',
        geometryType: 'point',
        fields: [
          { name: 'OWNER', type: 'string', searchable: true },
          { name: 'NOTES', type: 'string' },
        ],
      },
    ]);
  });

  it('returns null for non-v3 payloads', () => {
    expect(readSearchableLayers({ version: 2, layers: [] })).toBeNull();
    expect(readSearchableLayers(null)).toBeNull();
  });
});
