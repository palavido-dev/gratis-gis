// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { encryptCredential, _resetKeyCacheForTests } from '../items/credential-cipher.js';
import type { ItemsService } from '../items/items.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AiProviderClient } from './ai-provider.client.js';
import { AiDraftService } from './ai-draft.service.js';
import { parseModelDraft } from './draft-parse.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const ITEM = '22222222-2222-4222-8222-222222222222';
const SECRET = 'sk-test-secret-do-not-leak';
const GEOM = 'SECRET_GEOM_-97.7431';
const ATTR = 'SECRET_ATTR_beaumont';
const FILTER_VALUE = 'SECRET_FILTER_VALUE';

function user(): AuthUser {
  return {
    id: 'user-1',
    orgId: ORG,
    orgSlug: 'acme',
    username: 'ada',
    email: 'ada@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    orgId: ORG,
    type: 'map',
    title: 'County parcels',
    description: 'Parcels used for inspections.',
    data: {
      layers: [
        {
          title: 'Parcels',
          filter: {
            combinator: 'all',
            clauses: [{ field: 'status', op: '==', value: FILTER_VALUE }],
          },
        },
      ],
      drawings: [{ geometry: { type: 'Point', coordinates: [GEOM, 30.26] } }],
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [GEOM, 30.26] },
            properties: { city: ATTR },
          },
        ],
      },
    },
    ...overrides,
  };
}

function providerRow() {
  const enc = encryptCredential(SECRET, `ai-provider:${ORG}`);
  return {
    orgId: ORG,
    provider: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: null as string | null,
    encryptedSecret: enc.ciphertext,
    encryptedSecretIv: enc.iv,
    updatedBy: 'user-1',
  };
}

const DRAFT_JSON = JSON.stringify({
  summary: 'A draft filter for open parcels.',
  mapFilter: {
    layerTitle: 'Parcels',
    filter: {
      combinator: 'all',
      clauses: [{ field: 'status', op: '==', value: 'open' }],
    },
  },
  layerSummary: null,
  formFields: [],
});

describe('AiDraftService', () => {
  const savedKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = savedKey;
    _resetKeyCacheForTests();
  });

  function setup(opts: {
    row?: ReturnType<typeof providerRow> | null;
    itemResult?: unknown;
    itemError?: unknown;
  }) {
    const itemWrites: string[] = [];
    const prisma = {
      orgAiProvider: {
        findUnique: jest.fn(async () => (opts.row === undefined ? providerRow() : opts.row)),
        upsert: jest.fn(async () => {
          throw new Error('config write during draft');
        }),
        update: jest.fn(async () => {
          throw new Error('config write during draft');
        }),
        delete: jest.fn(async () => {
          throw new Error('config write during draft');
        }),
        deleteMany: jest.fn(async () => {
          throw new Error('config write during draft');
        }),
      },
      item: new Proxy(
        {},
        {
          get(_target, prop) {
            return () => {
              itemWrites.push(String(prop));
              throw new Error(`item.${String(prop)} wrote during draft`);
            };
          },
        },
      ),
    };
    const get = jest.fn(async () => {
      if (opts.itemError) throw opts.itemError;
      return opts.itemResult ?? item();
    });
    const items = new Proxy(
      { get },
      {
        get(target, prop) {
          if (prop === 'get') return target.get;
          return () => {
            throw new Error(`items.${String(prop)} called during draft`);
          };
        },
      },
    );
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: DRAFT_JSON } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new AiProviderClient();
    client.fetchImpl = fetchImpl as unknown as typeof fetch;
    const service = new AiDraftService(
      items as unknown as ItemsService,
      new AiConfigService(prisma as unknown as PrismaService),
      client,
    );
    return { service, fetchImpl, get, itemWrites, prisma };
  }

  it('returns a draft and does not write the item or the provider row', async () => {
    const { service, fetchImpl, get, itemWrites, prisma } = setup({});
    const result = await service.draft(user(), ITEM, 'Suggest a filter for open parcels');

    expect(result.draft.summary).toBe('A draft filter for open parcels.');
    expect(result.draft.mapFilter?.filter.clauses[0]?.field).toBe('status');
    expect(get).toHaveBeenCalledTimes(1);
    expect(itemWrites).toEqual([]);
    expect(prisma.orgAiProvider.upsert).not.toHaveBeenCalled();
    expect(prisma.orgAiProvider.update).not.toHaveBeenCalled();
    expect(prisma.orgAiProvider.deleteMany).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const init = fetchImpl.mock.calls[0]?.[1];
    const body = String(init?.body ?? '');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(GEOM);
    expect(body).not.toContain(ATTR);
    expect(body).not.toContain(FILTER_VALUE);
    expect(body).toContain('status');
    expect(body).toContain('Parcels');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('returns 409 and does not call the provider when nothing is configured', async () => {
    const { service, fetchImpl } = setup({ row: null });
    await expect(
      service.draft(user(), ITEM, 'Summarize this map'),
    ).rejects.toBeInstanceOf(ConflictException);
    try {
      await service.draft(user(), ITEM, 'Summarize this map');
    } catch (err) {
      const body = (err as ConflictException).getResponse() as { code?: string };
      expect(body.code).toBe('ai_not_configured');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 404 and does not call the provider when the item cannot be read', async () => {
    const { service, fetchImpl, prisma } = setup({
      itemError: new NotFoundException('Item not found'),
    });
    await expect(
      service.draft(user(), ITEM, 'Summarize this map'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prisma.orgAiProvider.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 when the item belongs to another org', async () => {
    const { service, fetchImpl } = setup({
      itemResult: item({ orgId: OTHER_ORG }),
    });
    await expect(
      service.draft(user(), ITEM, 'Summarize this map'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('parseModelDraft', () => {
  it('accepts a fenced JSON object', () => {
    const draft = parseModelDraft('```json\n{"summary":"Hello"}\n```');
    expect(draft.summary).toBe('Hello');
    expect(draft.mapFilter).toBeNull();
    expect(draft.formFields).toEqual([]);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseModelDraft('sure, here is an idea')).toThrow(
      'usable draft',
    );
  });
});
