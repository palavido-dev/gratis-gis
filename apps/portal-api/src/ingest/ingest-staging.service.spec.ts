// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { NotFoundException } from '@nestjs/common';

import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { serverUploadName } from './ingest-disk-path.js';
import { IngestStagingService } from './ingest-staging.service.js';

const OWNER = 'user-1';

describe('IngestStagingService stored names', () => {
  const previous = process.env.STAGING_DIR;
  let root: string;
  let staging: IngestStagingService;
  const extra: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gg-staging-spec-'));
    process.env.STAGING_DIR = root;
    staging = new IngestStagingService({
      shouldRun: () => false,
    } as unknown as LeaderElectionService);
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.STAGING_DIR;
    else process.env.STAGING_DIR = previous;
    rmSync(root, { recursive: true, force: true });
    for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function legacyStaging(meta: Record<string, unknown>, fileName: string, body: string): string {
    const id = '0123abcd-0000-4000-8000-00000000beef';
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, fileName), body);
    writeFileSync(
      join(root, id, 'meta.json'),
      JSON.stringify({ ownerId: OWNER, sizeBytes: body.length, createdAt: new Date().toISOString(), ...meta }),
    );
    return id;
  }

  it('reads back a stream staging, as the analysis bridge writes it', async () => {
    const staged = await staging.stageStream({
      stream: Readable.from([Buffer.from('{"type":"FeatureCollection","features":[]}')]),
      originalName: 'contours.geojson',
      ownerId: OWNER,
    });
    const got = await staging.getStaging(staged.stagingId, OWNER);
    expect(basename(got.filePath)).toBe('contours.geojson');
    expect(readFileSync(got.filePath, 'utf8')).toContain('FeatureCollection');
    expect(got.originalName).toBe('contours.geojson');
  });

  it('keeps the probe layer counts for the import jobs that follow', async () => {
    const staged = await staging.stage({
      buffer: Buffer.from('{"type":"FeatureCollection","features":[]}'),
      originalName: 'counts.json',
      ownerId: OWNER,
    });
    await staging.recordLayerCounts(staged.stagingId, OWNER, [
      { name: 'parcels', featureCount: 1200 },
      { name: '__proto__', featureCount: 3 },
    ]);
    const got = await staging.getStaging(staged.stagingId, OWNER);
    expect(got.layerCounts?.get('parcels')).toBe(1200);
    expect(got.layerCounts?.get('__proto__')).toBe(3);
    // An upload that happens to be named like the counts file keeps its bytes.
    expect(readFileSync(got.filePath, 'utf8')).toContain('FeatureCollection');
  });

  it('reads back a buffer staging', async () => {
    const staged = await staging.stage({
      buffer: Buffer.from('a,b\n1,2\n'),
      originalName: 'table.csv',
      ownerId: OWNER,
    });
    const got = await staging.getStaging(staged.stagingId, OWNER);
    expect(readFileSync(got.filePath, 'utf8')).toBe('a,b\n1,2\n');
  });

  it('does not let an upload named meta.json replace the record', async () => {
    const staged = await staging.stage({
      buffer: Buffer.from('{"x":1}'),
      originalName: 'meta.json',
      ownerId: OWNER,
    });
    const got = await staging.getStaging(staged.stagingId, OWNER);
    expect(basename(got.filePath)).not.toBe('meta.json');
    expect(readFileSync(got.filePath, 'utf8')).toBe('{"x":1}');
  });

  it('keeps the picked file name for a disk upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-ingest-'));
    extra.push(dir);
    const name = serverUploadName('parcels.geojson');
    writeFileSync(join(dir, name), '{}');
    const staged = await staging.stageFromPath({
      filePath: join(dir, name),
      originalName: 'parcels.geojson',
      ownerId: OWNER,
    });
    const got = await staging.getStaging(staged.stagingId, OWNER);
    expect(basename(got.filePath)).toBe('parcels.geojson');
  });

  it('still loads a staging written before storedName existed', async () => {
    const id = legacyStaging({ originalName: 'old parcels.geojson' }, 'old_parcels.geojson', '{}');
    const got = await staging.getStaging(id, OWNER);
    expect(got.filePath).toBe(join(realpathSync(root), id, 'old_parcels.geojson'));
    expect(got.originalName).toBe('old parcels.geojson');
  });

  it('refuses a storedName that leaves the staging directory', async () => {
    const outside = join(root, 'secret.geojson');
    writeFileSync(outside, 'secret');
    for (const storedName of ['../secret.geojson', '..', '/etc/passwd', 'meta.json', '.hidden']) {
      rmSync(join(root, '0123abcd-0000-4000-8000-00000000beef'), { recursive: true, force: true });
      const id = legacyStaging({ originalName: 'x.geojson', storedName }, 'x.geojson', '{}');
      await expect(staging.getStaging(id, OWNER)).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});
