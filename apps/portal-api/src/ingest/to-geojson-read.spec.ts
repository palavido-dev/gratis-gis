// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';

import { IngestService } from './ingest.service.js';

/**
 * The GDAL read behind /ingest/to-geojson for files too large for the
 * in-memory CSV detector. It used plain gdal.open, which gives a CSV
 * with LAT / LNG columns no geometry, so every row was dropped and the
 * caller got an empty collection.
 */
describe('IngestService GDAL collect read', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-ingest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function read(svc: IngestService, path: string) {
    return (
      svc as unknown as {
        readVectorFileAtPath(p: string, n: string): Promise<{ geojson: { features: unknown[] } }>;
      }
    ).readVectorFileAtPath(path, 'points.csv');
  }

  it('finds LAT / LNG columns the way the import path does', async () => {
    const path = join(dir, 'payload.csv');
    await writeFile(path, 'name,LAT,LNG\na,38.9,-77.0\nb,39.1,-76.9\n');
    const out = await read(new IngestService(), path);
    expect(out.geojson.features).toHaveLength(2);
  });

  it('says so when no row has a location instead of returning nothing', async () => {
    const path = join(dir, 'payload.csv');
    await writeFile(path, 'name,value\na,1\nb,2\n');
    await expect(read(new IngestService(), path)).rejects.toBeInstanceOf(BadRequestException);
  });
});
