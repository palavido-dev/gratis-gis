// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IngestService } from './ingest.service.js';

describe('IngestService address CSV', () => {
  const csv =
    'name,address\nOffice,"1600 Pennsylvania Ave NW, Washington, DC"\nAnnex,"1 Nowhere Road"\n';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('probes and streams points when the local geocoder answers', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/status')) return new Response('OK', { status: 200 });
      if (url.includes('Nowhere')) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify([{ lat: '38.8977', lon: '-77.0365' }]), {
        status: 200,
      });
    });
    const dir = await mkdtemp(join(tmpdir(), 'gg-ingest-'));
    const filePath = join(dir, 'sites.csv');
    await writeFile(filePath, csv);
    try {
      const ingest = new IngestService();
      const probe = await ingest.probeFileFromPath(filePath);
      expect(probe.driver).toBe('csv-address');
      expect(probe.layers[0]).toMatchObject({
        name: 'sites',
        geometryType: 'point',
        featureCount: 2,
      });
      const batches: Array<{ geometry: unknown; properties: Record<string, unknown> }> =
        [];
      const meta = await ingest.streamLayerFromPath(
        filePath,
        'sites',
        async (batch) => {
          batches.push(...batch);
        },
      );
      expect(meta.driver).toBe('csv-address');
      expect(meta.sourceSrs).toBe('EPSG:4326');
      expect(batches).toHaveLength(1);
      expect(batches[0]?.geometry).toEqual({
        type: 'Point',
        coordinates: [-77.0365, 38.8977],
      });
      expect(batches[0]?.properties.name).toBe('Office');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the file on the table path when the geocoder is down', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('down'));
    const dir = await mkdtemp(join(tmpdir(), 'gg-ingest-'));
    const filePath = join(dir, 'sites.csv');
    await writeFile(filePath, csv);
    const ingest = new IngestService();
    try {
      const probe = await ingest.probeFileFromPath(filePath);
      expect(probe.driver).not.toBe('csv-address');
      expect(probe.layers[0]?.geometryType ?? null).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
