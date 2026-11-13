// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';

import { DataLayerFeaturesController } from './features.controller.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { writeGeoParquetExport } from './geoparquet-export.js';

// The export itself needs DuckDB; these specs only drive the handler.
jest.mock('./geoparquet-export.js', () => ({
  writeGeoParquetExport: jest.fn(),
}));
const writeExport = writeGeoParquetExport as jest.MockedFunction<
  typeof writeGeoParquetExport
>;

/**
 * Download-tier gate coverage for the GeoParquet export (#174).
 *
 * The endpoint is the FIRST enforcer of SharingService.canDownload:
 * the tier has existed since #32 and the item payload surfaces it,
 * but until this route nothing on the server refused a bulk read
 * over it. The spec drives the controller directly with fakes (the
 * same style as admin-users.controller.spec.ts) and pins two
 * behaviors: a caller without the tier gets a 403, and the export
 * pipeline is never started for them.
 */

const ITEM_ID = '11111111-1111-7111-8111-111111111111';
const LAYER_ID = 'facilities';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-viewer',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'viewer',
    email: 'viewer@example.test',
    orgRole: 'viewer',
    groupIds: [],
    ...overrides,
  } as unknown as AuthUser;
}

function makeController(opts: { canDownload: boolean }) {
  // Minimal v3 data_layer item: enough for assertV3Layer to accept
  // the layer and for the filename helper to resolve labels.
  const item = {
    id: ITEM_ID,
    type: 'data_layer',
    title: 'Sample Facilities',
    ownerId: 'user-owner',
    orgId: 'org-1',
    access: 'private',
    data: {
      version: 3,
      layers: [
        {
          id: LAYER_ID,
          name: 'facilities',
          label: 'Facilities',
          geometryType: 'point',
          fields: [{ name: 'name', type: 'string', label: 'Name' }],
        },
      ],
    },
    shares: [],
  };

  const items = {
    get: jest.fn(async () => item),
    assertCanEdit: jest.fn(async () => undefined),
  };
  const sharing = {
    canDownload: jest.fn(() => opts.canDownload),
    geoLimitFor: jest.fn(async () => null),
    effectiveRowScope: jest.fn(() => 'all' as const),
    featureScopeFor: jest.fn(async (u: { id: string }) => ({
      geoLimit: null,
      rowScope: 'all' as const,
      userId: u.id,
    })),
  };
  const iterateFeatures = jest.fn(async function* (): AsyncGenerator<unknown[], void> {
    yield [];
  });
  const v3 = { iterateFeatures };

  const controller = new DataLayerFeaturesController(
    items as unknown as ConstructorParameters<
      typeof DataLayerFeaturesController
    >[0],
    sharing as unknown as ConstructorParameters<
      typeof DataLayerFeaturesController
    >[1],
    v3 as unknown as ConstructorParameters<
      typeof DataLayerFeaturesController
    >[2],
    {} as ConstructorParameters<typeof DataLayerFeaturesController>[3],
    {} as ConstructorParameters<typeof DataLayerFeaturesController>[4],
    {} as ConstructorParameters<typeof DataLayerFeaturesController>[5],
  );
  return { controller, items, sharing, iterateFeatures };
}

function makeRes(): Response {
  return {
    setHeader: jest.fn(),
    destroy: jest.fn(),
  } as unknown as Response;
}

describe('DataLayerFeaturesController.geoparquet download gate', () => {
  it('rejects with 403 when canDownload says no', async () => {
    const { controller, items, sharing, iterateFeatures } = makeController({
      canDownload: false,
    });

    await expect(
      controller.geoparquet(makeRes(), makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toThrow(ForbiddenException);

    // Visibility ran first (a reader who cannot even see the item
    // still gets assertV3Layer's 404, not this 403)...
    expect(items.get).toHaveBeenCalled();
    // ...the decision consulted the real policy surface...
    expect(sharing.canDownload).toHaveBeenCalledTimes(1);
    // ...and no feature ever left the engine for the denied caller.
    expect(iterateFeatures).not.toHaveBeenCalled();
  });

  it('gates the csv route on the same download tier', async () => {
    // Originally csv kept its historical read-only gating and this
    // spec pinned that; the consistency decision after #174 gates
    // every attachment-download endpoint identically. /geojson is
    // deliberately NOT gated (map overlay source, read tier).
    const { controller, sharing } = makeController({ canDownload: false });
    const res = makeRes();
    const send = jest.fn();
    (res as unknown as { send: jest.Mock }).send = send;
    const listFeatures = jest
      .spyOn(controller, 'listFeatures')
      .mockResolvedValue(undefined);

    await expect(
      controller.csv(res, makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toThrow(ForbiddenException);

    expect(sharing.canDownload).toHaveBeenCalledTimes(1);
    // The denied caller never pulls rows and never gets a body.
    expect(listFeatures).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    listFeatures.mockRestore();
  });
});

describe('DataLayerFeaturesController.csv error handling', () => {
  function streamRes() {
    const state = { body: '', ended: false, destroyed: false, headers: 0 };
    const res = {
      destroyed: false,
      setHeader: jest.fn(() => {
        state.headers += 1;
      }),
      write: jest.fn((chunk: string) => {
        state.body += chunk;
        return true;
      }),
      end: jest.fn(() => {
        state.ended = true;
      }),
      destroy: jest.fn(() => {
        state.destroyed = true;
      }),
    };
    return { res: res as unknown as Response, state };
  }

  it('fails as a real error, with no headers sent, when the first page fails', async () => {
    const { controller, iterateFeatures } = makeController({ canDownload: true });
    // eslint-disable-next-line require-yield
    iterateFeatures.mockImplementation(async function* () {
      throw new Error('statement timeout');
    });
    const { res, state } = streamRes();
    await expect(
      controller.csv(res, makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toThrow('statement timeout');
    expect(state.headers).toBe(0);
    expect(state.body).toBe('');
  });

  it('aborts the transfer instead of ending it cleanly on a mid-stream error', async () => {
    // A CSV has no closing marker: a normal end would look like a
    // complete file that silently stops part way.
    const { controller, iterateFeatures } = makeController({ canDownload: true });
    iterateFeatures.mockImplementation(async function* () {
      yield [{ id: 'a', properties: { name: 'one' }, geometry: null }];
      throw new Error('statement timeout');
    });
    const { res, state } = streamRes();
    await controller.csv(res, makeUser(), ITEM_ID, LAYER_ID);
    expect(state.body).toContain('one');
    expect(state.destroyed).toBe(true);
    expect(state.ended).toBe(false);
  });
});

describe('DataLayerFeaturesController.csv on a layer with no declared fields', () => {
  it('derives the columns from the rows instead of writing geometry only', async () => {
    const { controller, items, iterateFeatures } = makeController({
      canDownload: true,
    });
    const item = await items.get();
    (item.data.layers[0] as { fields: unknown[] }).fields = [];
    items.get.mockResolvedValue(item);
    iterateFeatures.mockImplementation(async function* () {
      yield [
        { id: 'a', properties: { kind: 'oak', height: 12 }, geometry: null },
        { id: 'b', properties: { kind: 'elm' }, geometry: null },
      ];
    });
    let body = '';
    const res = {
      destroyed: false,
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => {
        body += chunk;
        return true;
      }),
      end: jest.fn(),
      destroy: jest.fn(),
    } as unknown as Response;
    await controller.csv(res, makeUser(), ITEM_ID, LAYER_ID, undefined, undefined, undefined, undefined, undefined, 'none');
    expect(body.split('\r\n')).toEqual(['kind,height', 'oak,12', 'elm,']);
    // One pass to find the columns, one to write the rows.
    expect(iterateFeatures).toHaveBeenCalledTimes(2);
  });
});

describe('DataLayerFeaturesController.geoparquet limits', () => {
  afterEach(() => writeExport.mockReset());

  it('answers 429 once the export slots are full, and frees a slot when one ends', async () => {
    const { controller } = makeController({ canDownload: true });
    const release: Array<() => void> = [];
    writeExport.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          release.push(() => reject(new Error('stopped')));
        }),
    );
    const res = () =>
      ({ setHeader: jest.fn(), req: undefined }) as unknown as Response;
    const a = controller.geoparquet(res(), makeUser(), ITEM_ID, LAYER_ID);
    const b = controller.geoparquet(res(), makeUser(), ITEM_ID, LAYER_ID);
    // Let both reach the export before the third asks. Wait on the
    // real condition, not a fixed delay: under a loaded CI runner 20 ms
    // was sometimes not enough, the third call took a slot and hung,
    // and the leaked slot then failed the next test too.
    for (let i = 0; i < 500 && release.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(release).toHaveLength(2);
    await expect(
      controller.geoparquet(res(), makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toMatchObject({ status: 429 });
    release.forEach((fn) => fn());
    await expect(a).rejects.toThrow('stopped');
    await expect(b).rejects.toThrow('stopped');
    // Both slots are free again.
    writeExport.mockRejectedValue(new Error('again'));
    await expect(
      controller.geoparquet(res(), makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toThrow('again');
  });

  it('stops pulling rows once the client has gone', async () => {
    const { controller, iterateFeatures } = makeController({ canDownload: true });
    let pulled = 0;
    iterateFeatures.mockImplementation(async function* () {
      for (;;) {
        pulled += 1;
        yield [];
      }
    });
    const req = new EventEmitter();
    const r = { setHeader: jest.fn(), req, writableEnded: false } as unknown as Response;
    writeExport.mockImplementation(async ({ batches }) => {
      for await (const _b of batches) {
        if (pulled === 3) req.emit('close');
      }
      return { path: '/nonexistent', rows: 0 };
    });
    await expect(
      controller.geoparquet(r, makeUser(), ITEM_ID, LAYER_ID),
    ).rejects.toThrow('client closed');
    expect(pulled).toBeLessThanOrEqual(4);
  });
});

describe('DataLayerFeaturesController.append notifications', () => {
  it('notifies only for rows the request actually inserted', async () => {
    // A retried batch with one new row used to notify for every row.
    const base = makeController({ canDownload: true });
    const notify = jest.fn(async () => undefined);
    const prisma = {
      item: {
        findUnique: jest.fn(async () => ({
          id: 'editor-1',
          title: 'Editor',
          ownerId: 'owner',
          type: 'editor',
          data: {},
        })),
      },
      user: { findUnique: jest.fn(async () => ({ fullName: 'Field User' })) },
    };
    const v3 = {
      insertFeatures: jest.fn(async () => ({
        inserted: 1,
        deduplicated: 2,
        globalIds: ['g-0', 'g-1', 'g-2'],
        insertedIndices: [1],
      })),
    };
    const C = DataLayerFeaturesController as unknown as new (
      ...args: unknown[]
    ) => DataLayerFeaturesController;
    const controller = new C(
      base.items,
      base.sharing,
      v3,
      prisma,
      { assertAllows: jest.fn(async () => undefined) },
      { notify },
    );
    const out = await controller.append(
      makeUser(),
      ITEM_ID,
      LAYER_ID,
      {
        features: [
          { globalId: 'g-0', properties: { name: 'a' } },
          { globalId: 'g-1', properties: { name: 'b' } },
          { globalId: 'g-2', properties: { name: 'c' } },
        ],
      } as never,
      'editor-1',
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      'owner',
      'editor_feature_created',
      expect.objectContaining({ featureId: 'g-1' }),
    );
    // The reply shape is unchanged.
    expect(out).toEqual({
      inserted: 1,
      deduplicated: 2,
      globalIds: ['g-0', 'g-1', 'g-2'],
    });
  });

  it('sends one summary when a request creates more than 10 features', async () => {
    const base = makeController({ canDownload: true });
    const notify = jest.fn(async () => undefined);
    const prisma = {
      item: {
        findUnique: jest.fn(async () => ({
          id: 'editor-1',
          title: 'Editor',
          ownerId: 'owner',
          type: 'editor',
          data: {},
        })),
      },
      user: { findUnique: jest.fn(async () => ({ fullName: 'Field User' })) },
    };
    const n = 25;
    const ids = Array.from({ length: n }, (_, i) => `g-${i}`);
    const v3 = {
      insertFeatures: jest.fn(async () => ({
        inserted: n,
        deduplicated: 0,
        globalIds: ids,
        insertedIndices: ids.map((_, i) => i),
      })),
    };
    const C = DataLayerFeaturesController as unknown as new (
      ...args: unknown[]
    ) => DataLayerFeaturesController;
    const controller = new C(
      base.items,
      base.sharing,
      v3,
      prisma,
      { assertAllows: jest.fn(async () => undefined) },
      { notify },
    );
    await controller.append(
      makeUser(),
      ITEM_ID,
      LAYER_ID,
      {
        features: ids.map((g) => ({ globalId: g, properties: { name: g } })),
      } as never,
      'editor-1',
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      'owner',
      'editor_feature_created',
      expect.objectContaining({
        featureId: 'g-0',
        featureCount: 25,
        summary: '25 new features',
      }),
    );
  });
});

describe('where fields are checked on every filtered read', () => {
  const where = JSON.stringify({
    combinator: 'all',
    clauses: [{ field: 'renamed', op: '==', value: 'x' }],
  });

  it('features-page answers 400 for a field not on the layer', async () => {
    const { controller } = makeController({ canDownload: true });
    await expect(
      controller.featuresPage(
        makeUser(), ITEM_ID, LAYER_ID,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        where,
      ),
    ).rejects.toThrow('"renamed" is not a field on this layer.');
  });

  it('filtered-extent answers 400 for a field not on the layer', async () => {
    const { controller } = makeController({ canDownload: true });
    await expect(
      controller.filteredExtent(makeUser(), ITEM_ID, LAYER_ID, where),
    ).rejects.toThrow('"renamed" is not a field on this layer.');
  });
});

describe('DataLayerFeaturesController geo-limit write check', () => {
  it('checks the whole batch in one query and reports malformed geometry as a 422 row', async () => {
    const base = makeController({ canDownload: true });
    base.sharing.featureScopeFor.mockImplementation(async (u: { id: string }) => ({
      geoLimit: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      rowScope: 'all' as const,
      userId: u.id,
    }) as never);
    // The database says the second candidate is outside.
    const queryRaw = jest.fn(async () => [{ ord: 2 }]);
    const insertFeatures = jest.fn();
    const C = DataLayerFeaturesController as unknown as new (
      ...args: unknown[]
    ) => DataLayerFeaturesController;
    const controller = new C(
      base.items,
      base.sharing,
      { insertFeatures },
      { $queryRaw: queryRaw },
      {},
      {},
    );
    const err = await controller
      .append(makeUser(), ITEM_ID, LAYER_ID, {
        features: [
          { geometry: { type: 'Point', coordinates: [0.5, 0.5] } },
          { geometry: { type: 'Point', coordinates: [5, 5] } },
          { geometry: { type: 'Nonsense' } },
          { properties: { name: 'no geometry' } },
        ],
      } as never)
      .catch((e: unknown) => e);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect((err as { getStatus(): number }).getStatus()).toBe(422);
    expect((err as { getResponse(): { offendingIndices: number[] } }).getResponse().offendingIndices)
      .toEqual([1, 2]);
    expect(insertFeatures).not.toHaveBeenCalled();
  });
});

describe('time filter bounds', () => {
  it('answers 400 for a bound that is not a date', async () => {
    const { controller } = makeController({ canDownload: true });
    const res = { setHeader: jest.fn() } as unknown as Response;
    await expect(
      controller.listFeatures(
        makeUser(), ITEM_ID, LAYER_ID, res,
        undefined, undefined, undefined, undefined, undefined, undefined,
        'name', 'yesterday',
      ),
    ).rejects.toThrow(/timeFrom and timeTo must be dates/);
  });
});

