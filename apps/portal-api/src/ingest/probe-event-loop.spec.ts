// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IngestService } from './ingest.service.js';

/**
 * The probe runs in the API process for every wizard upload. With the
 * sync GDAL open and count, a large GeoJSON held the event loop for
 * the whole parse and nothing else was answered. The async forms run
 * in GDAL's worker threads.
 */
describe('probe keeps the event loop free', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-ingest-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers timers while a large GeoJSON is opened and counted', async () => {
    const features = Array.from({ length: 150_000 }, (_, i) => ({
      type: 'Feature',
      properties: { id: i, name: `feature ${i}` },
      geometry: { type: 'Point', coordinates: [(i % 360) - 180, (i % 170) - 85] },
    }));
    const path = join(dir, 'payload.geojson');
    await writeFile(path, JSON.stringify({ type: 'FeatureCollection', features }));

    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    const started = Date.now();
    const probe = await new IngestService().probeFileFromPath(path);
    const elapsed = Date.now() - started;
    clearInterval(timer);

    expect(probe.layers[0]!.featureCount).toBe(150_000);
    // A blocked loop fires the timer once or not at all during the
    // probe. Free, it fires for a good share of the elapsed time.
    expect(ticks).toBeGreaterThan(Math.max(3, elapsed / 5 / 4));
  });
});
