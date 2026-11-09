// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { PublicController } from '../public/public.controller.js';
import { redactItemData } from './item-data-redact.js';
import { ItemsService } from './items.service.js';
import { SharingService } from './sharing.service.js';

/**
 * Item reads used to return `data` verbatim, so:
 *   - every reader of a map (signed in or anonymous on a public map)
 *     got each anonymous reviewer's markup token, which is enough to
 *     edit or delete their markup;
 *   - every reader of a data layer got the sync-conflict artifacts,
 *     full copies of conflicted features that a row-scoped or
 *     geo-limited viewer may not read;
 *   - the anonymous public item endpoint skipped the per-layer filter
 *     signed-in viewers get, so logging out showed more.
 */

const MAP_ID = '00000000-0000-4000-8000-0000000000aa';
const PUBLIC_LAYER = '00000000-0000-4000-8000-0000000000b1';
const PRIVATE_LAYER = '00000000-0000-4000-8000-0000000000b2';

function user(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'viewer-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'v',
    email: 'v@example.com',
    orgRole: 'viewer',
    groupIds: [],
    capabilities: new Set(),
    ...over,
  } as AuthUser;
}

const mapData = () => ({
  layers: [
    { id: 'l1', source: { kind: 'data-layer', itemId: PUBLIC_LAYER } },
    { id: 'l2', source: { kind: 'data-layer', itemId: PRIVATE_LAYER } },
    {
      id: 'l3',
      source: { kind: 'url', url: 'https://tiles.example.org' },
      access: {
        policy: 'custom',
        entries: [{ principalType: 'user', principalId: 'u9', view: true, query: true, edit: false }],
      },
    },
    { id: 'l4', source: { kind: 'url', url: 'https://tiles.example.org/b' } },
  ],
  drawings: [
    { id: 'set-1', authorId: null, authorDisplay: 'Anonymous reviewer 1', anonymousAuthorToken: 'secret-token' },
  ],
});

const layerData = () => ({
  version: 3,
  layers: [
    {
      id: 'L1',
      syncConflicts: [{ id: 'c1', losingSide: { properties: { owner: 'someone' } } }],
    },
  ],
});

function row(id: string, over: Record<string, unknown>) {
  return {
    id,
    orgId: 'org-1',
    ownerId: 'owner-1',
    type: 'map',
    title: 't',
    description: '',
    tags: [],
    access: 'org',
    data: {},
    deletedAt: null,
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    thumbnailUrl: null,
    thumbnailDesign: null,
    shares: [] as unknown[],
    owner: null,
    ...over,
  };
}

describe('redactItemData', () => {
  it('always removes anonymous markup tokens from a map', () => {
    const out = redactItemData('map', mapData(), { canEdit: true }) as ReturnType<typeof mapData>;
    expect(out.drawings[0]).not.toHaveProperty('anonymousAuthorToken');
    expect(out.drawings[0]!.authorDisplay).toBe('Anonymous reviewer 1');
  });

  it('removes sync conflicts from a data layer unless the reader can edit', () => {
    const viewer = redactItemData('data_layer', layerData(), { canEdit: false }) as ReturnType<typeof layerData>;
    expect(viewer.layers[0]).not.toHaveProperty('syncConflicts');
    const editor = redactItemData('data_layer', layerData(), { canEdit: true }) as ReturnType<typeof layerData>;
    expect(editor.layers[0]!.syncConflicts).toHaveLength(1);
  });
});

function makeItems(rows: Record<string, ReturnType<typeof row>>) {
  const prisma = {
    item: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
      findMany: jest.fn(async (args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args.where?.id?.in;
        return ids ? ids.map((i) => rows[i]).filter(Boolean) : Object.values(rows);
      }),
    },
    itemShare: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
  };
  const sharing = new SharingService(prisma as never, new PolicyService());
  const svc = new ItemsService(
    prisma as never,
    sharing,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, prisma };
}

describe('ItemsService reads', () => {
  it('getForReader strips markup tokens for the map owner while get() keeps them for update()', async () => {
    const { svc } = makeItems({ [MAP_ID]: row(MAP_ID, { data: mapData(), ownerId: 'viewer-1' }) });
    const owner = user({ orgRole: 'contributor' });
    const shown = (await svc.getForReader(owner, MAP_ID)).data as ReturnType<typeof mapData>;
    expect(shown.drawings[0]).not.toHaveProperty('anonymousAuthorToken');
    const raw = (await svc.get(owner, MAP_ID)).data as ReturnType<typeof mapData>;
    expect(raw.drawings[0]!.anonymousAuthorToken).toBe('secret-token');
  });

  it('getForReader strips sync conflicts for a data layer viewer', async () => {
    const { svc } = makeItems({ L: row('L', { type: 'data_layer', data: layerData() }) });
    const shown = (await svc.getForReader(user(), 'L')).data as ReturnType<typeof layerData>;
    expect(shown.layers[0]).not.toHaveProperty('syncConflicts');
  });

  it('list with full data applies the same redaction per row', async () => {
    const { svc } = makeItems({
      [MAP_ID]: row(MAP_ID, { data: mapData() }),
      L: row('L', { type: 'data_layer', data: layerData() }),
    });
    const rows = (await svc.list(user(), {})) as unknown as Array<{ id: string; data: unknown }>;
    const map = rows.find((r) => r.id === MAP_ID)!.data as ReturnType<typeof mapData>;
    const layer = rows.find((r) => r.id === 'L')!.data as ReturnType<typeof layerData>;
    expect(map.drawings[0]).not.toHaveProperty('anonymousAuthorToken');
    expect(layer.layers[0]).not.toHaveProperty('syncConflicts');
  });
});

describe('PublicController.item', () => {
  it('gives an anonymous reader the filtered map with no tokens or rosters', async () => {
    const rows = {
      [MAP_ID]: row(MAP_ID, { access: 'public', data: mapData() }),
      [PUBLIC_LAYER]: row(PUBLIC_LAYER, { type: 'data_layer', access: 'public' }),
      [PRIVATE_LAYER]: row(PRIVATE_LAYER, { type: 'data_layer', access: 'private' }),
    };
    const { svc, prisma } = makeItems(rows);
    const controller = new PublicController(prisma as never, {} as never, svc);
    const out = (await controller.item(MAP_ID)) as unknown as {
      data: {
        layers: Array<{ id: string; access?: { entries: unknown[] } }>;
        drawings: Array<Record<string, unknown>>;
      };
    };
    expect(out.data.layers.map((l) => l.id)).toEqual(['l1', 'l4']);
    for (const l of out.data.layers) expect(l.access?.entries ?? []).toEqual([]);
    expect(out.data.drawings[0]).not.toHaveProperty('anonymousAuthorToken');
  });
});
