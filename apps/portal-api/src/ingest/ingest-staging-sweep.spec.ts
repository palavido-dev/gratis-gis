// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { IngestStagingService } from './ingest-staging.service.js';

/**
 * The staging sweep deletes uploads older than an hour. The import
 * worker runs one job at a time, so a job can wait longer than that in
 * the queue; its file must survive until the job is done with it.
 */
describe('IngestStagingService sweep keeps files that queued imports need', () => {
  const previous = process.env.STAGING_DIR;
  let root: string;

  const QUEUED = '11111111-1111-4111-8111-111111111111';
  const ORPHAN = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gg-staging-sweep-'));
    process.env.STAGING_DIR = root;
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    for (const id of [QUEUED, ORPHAN]) {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, 'f.geojson'), '{}');
      writeFileSync(
        join(root, id, 'meta.json'),
        JSON.stringify({ ownerId: 'u', originalName: 'f.geojson', sizeBytes: 2, createdAt: old }),
      );
    }
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.STAGING_DIR;
    else process.env.STAGING_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const sweep = (svc: IngestStagingService) =>
    (svc as unknown as { cleanupStaleSync(): Promise<void> }).cleanupStaleSync();

  it('keeps a staging with a queued or running import job and removes the rest', async () => {
    const findMany = jest.fn(async () => [{ stagingId: QUEUED }]);
    const svc = new IngestStagingService(
      { shouldRun: () => true } as unknown as LeaderElectionService,
      { importJob: { findMany } } as unknown as PrismaService,
    );
    await sweep(svc);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['queued', 'running'] } },
      }),
    );
    expect(existsSync(join(root, QUEUED))).toBe(true);
    expect(existsSync(join(root, ORPHAN))).toBe(false);
  });

  it('deletes nothing when it cannot tell which stagings are in use', async () => {
    const svc = new IngestStagingService(
      { shouldRun: () => true } as unknown as LeaderElectionService,
      {
        importJob: {
          findMany: async () => {
            throw new Error('database down');
          },
        },
      } as unknown as PrismaService,
    );
    await sweep(svc);
    expect(existsSync(join(root, QUEUED))).toBe(true);
    expect(existsSync(join(root, ORPHAN))).toBe(true);
  });
});
