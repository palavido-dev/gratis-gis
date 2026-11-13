// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Response } from 'express';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { IngestController } from './ingest.controller.js';
import { acquireIngestSlot, resetIngestSlotsForTests } from './ingest-slots.js';

/**
 * The synchronous v3 layer import streams for minutes over a file of up
 * to 1 GB. It must take the same ingest slot as the other upload routes,
 * and stamp per-layer featureCount the way the async worker does.
 */
const USER = { id: 'user-v3', orgId: 'org-v3', orgRole: 'admin' } as unknown as AuthUser;
const STAGING = '0123abcd-0000-4000-8000-00000000cafe';

function fakeRes() {
  const lines: string[] = [];
  const res = {
    headersSent: false,
    setHeader: () => undefined,
    flushHeaders() {
      this.headersSent = true;
    },
    status() {
      return this;
    },
    write: (chunk: string) => {
      lines.push(chunk);
      return true;
    },
    end: () => undefined,
  };
  return {
    res: res as unknown as Response,
    events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function makeController(
  assertCanImportAllRows: () => Promise<void> = async () => undefined,
) {
  const stampFeatureCounts = jest.fn(async () => true);
  const streamLayerFromPath = jest.fn(async () => ({
    fields: [],
    driver: 'GeoJSON',
    layerName: 'x',
    sourceSrs: 'EPSG:4326',
    total: 0,
  }));
  const tx = {
    $queryRaw: async () => [{ data: { version: 3, layers: [{ id: 'L1' }] } }],
    item: { update: async () => ({}) },
  };
  const controller = new IngestController(
    { streamLayerFromPath } as never,
    {
      get: async () => ({
        type: 'data_layer',
        data: { version: 3, layers: [{ id: 'L1', fields: [] }] },
      }),
      assertCanImportAllRows,
      assertLayerEditingEnabled: () => undefined,
    } as never,
    undefined as never,
    {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      item: {
        findUnique: async () => ({ data: { version: 3, layers: [] } }),
        update: async () => ({}),
      },
    } as never,
    undefined as never,
    { insertFeatures: async () => ({ inserted: 0 }) } as never,
    { stampFeatureCounts, aggregateBbox: async () => null } as never,
    {
      getStaging: async () => ({
        filePath: '/staged/x.geojson',
        originalName: 'x.geojson',
        sizeBytes: 10,
      }),
    } as never,
  );
  return { controller, stampFeatureCounts, streamLayerFromPath };
}

describe('IngestController.ingestV3Layer', () => {
  afterEach(() => resetIngestSlotsForTests());

  it('refuses while the same user already holds an ingest slot', async () => {
    const release = acquireIngestSlot(USER.id);
    const { controller, streamLayerFromPath } = makeController();
    const { res, events } = fakeRes();
    await controller.ingestV3Layer(res, USER, 'item-1', 'L1', undefined, {}, undefined, 'append', STAGING);
    release();
    expect(streamLayerFromPath).not.toHaveBeenCalled();
    expect(events().at(-1)).toMatchObject({ event: 'error' });
    expect(String(events().at(-1)!.message)).toMatch(/Too many imports/);
  });

  it('releases its slot and stamps feature counts when it finishes', async () => {
    const { controller, stampFeatureCounts } = makeController();
    const { res, events } = fakeRes();
    await controller.ingestV3Layer(res, USER, 'item-1', 'L1', undefined, {}, undefined, 'append', STAGING);
    expect(events().at(-1)).toMatchObject({ event: 'done' });
    expect(stampFeatureCounts).toHaveBeenCalledWith('item-1');
    // The slot was released: the same user can take it again.
    expect(() => acquireIngestSlot(USER.id)()).not.toThrow();
  });

  it('refuses an editor whose share is limited, before reading the file', async () => {
    const { ForbiddenException } = await import('@nestjs/common');
    const { controller, streamLayerFromPath } = makeController(async () => {
      throw new ForbiddenException('limited');
    });
    const { res, events } = fakeRes();
    await controller.ingestV3Layer(res, USER, 'item-1', 'L1', undefined, {}, undefined, 'replace', STAGING);
    expect(streamLayerFromPath).not.toHaveBeenCalled();
    expect(events().at(-1)).toMatchObject({
      event: 'error',
      message: 'You cannot import into that item.',
    });
  });
});
