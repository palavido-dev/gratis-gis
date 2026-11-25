// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AnalysisService } from './analysis.service.js';
import { SamController } from './sam.controller.js';

/**
 * The analysis worker reads a job's source files with the server's own
 * credentials. A source key in the org layout must name the org of the
 * item that authorised the job; older keys keep their earlier checks.
 */
const OWN = '0a1b2c3d-0000-4000-8000-00000000000a';
const OTHER = '0a1b2c3d-0000-4000-8000-00000000000b';
const FILE = '22222222-2222-4222-8222-222222222222';

const user = {
  id: 'u',
  orgId: OWN,
  orgRole: 'admin',
  capabilities: new Set(['can_publish_items']),
} as unknown as AuthUser;

function analysisWith(storageKey: string) {
  const items = {
    get: jest.fn(async () => ({
      id: 'pc',
      orgId: OWN,
      type: 'point_cloud',
      data: { version: 1, format: 'copc', storageKey },
    })),
  };
  return new AnalysisService(
    {} as never,
    items as never,
    {} as never,
    {} as never,
    { get: () => 'server-heavy' } as never,
  );
}

describe('analysis job sources', () => {
  it('refuses a source file that names another organization', async () => {
    const svc = analysisWith(`item-point-cloud/o/${OTHER}/${FILE}`);
    await expect(
      svc.createHillshadeJob(user, 'pc', { mode: 'dtm', resolution: 1 }),
    ).rejects.toThrow(/not stored where/);
  });

  it('passes a source file of its own organization and an older one on to the next checks', async () => {
    for (const key of [`item-point-cloud/o/${OWN}/${FILE}`, `item-point-cloud/${FILE}`]) {
      const svc = analysisWith(key);
      // The next check (an unusable mode) answers instead.
      await expect(
        svc.createHillshadeJob(user, 'pc', { mode: 'bogus' as never, resolution: 1 }),
      ).rejects.toThrow(/mode must be/);
    }
  });
});

describe('outline tool imagery', () => {
  function samWith(cogStorageKey: string) {
    const create = jest.fn(async () => ({ id: 'job-new' }));
    const c = new SamController(
      { analysisJob: { findFirst: async () => null, count: async () => 0, create } } as never,
      {
        get: async () => ({
          id: '0a1b2c3d-0000-4000-8000-0000000000f1',
          orgId: OWN,
          type: 'tile_layer',
          data: { kind: 'raster', cogStorageKey },
        }),
      } as never,
      { objectExists: async () => false } as never,
      { get: () => 'server-heavy' } as never,
    );
    (c as unknown as { assertServerTier: () => void }).assertServerTier = () => undefined;
    return { c, create };
  }

  it('refuses imagery whose file names another organization', async () => {
    const { c, create } = samWith(`item-tile-layer/o/${OTHER}/${FILE}`);
    await expect(c.ensure(user, 'img', { z: 16, gx: 1, gy: 1 })).rejects.toThrow(
      /not stored where/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('queues for imagery of its own organization', async () => {
    const { c, create } = samWith(`item-tile-layer/o/${OWN}/${FILE}`);
    await expect(c.ensure(user, 'img', { z: 16, gx: 1, gy: 1 })).resolves.toMatchObject({
      state: 'working',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('notes each served embedding for the per-item cap', async () => {
    const noteRead = jest.fn(async () => undefined);
    const { Readable } = await import('node:stream');
    const c = new SamController(
      {} as never,
      {
        get: async () => ({
          id: '0a1b2c3d-0000-4000-8000-0000000000f1',
          orgId: OWN,
          type: 'tile_layer',
          data: { kind: 'raster', cogStorageKey: `item-tile-layer/o/${OWN}/${FILE}` },
        }),
      } as never,
      {
        objectExists: async () => true,
        noteRead,
        streamObject: async () => ({ body: Readable.from([Buffer.alloc(4)]), contentLength: 4 }),
      } as never,
      { get: () => 'server-heavy' } as never,
    );
    const { PassThrough } = await import('node:stream');
    const res = Object.assign(new PassThrough(), { status: jest.fn(), setHeader: jest.fn() });
    res.resume();
    await c.fetch(user, 'img', '16', '1', '1', res as never);
    expect(noteRead).toHaveBeenCalledWith(
      `sam-embed/o/${OWN}/0a1b2c3d-0000-4000-8000-0000000000f1/16/1/1.bin`,
    );
  });
});
