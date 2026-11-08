// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { serverUploadName } from './ingest-disk-path.js';
import { IngestStagingService } from './ingest-staging.service.js';
import { IngestService } from './ingest.service.js';

const OWNER = 'user-1';

/**
 * Stand-in for gdal-async that names a single-layer file the way the
 * GeoJSON and CSV drivers do: after the stem of the path it opened.
 * GDAL itself is not installed in every test environment.
 */
function stemNamingGdal() {
  return {
    open(path: string) {
      const base = basename(path);
      const name = base.slice(0, base.lastIndexOf('.'));
      return {
        driver: { description: 'GeoJSON' },
        layers: {
          count: () => 1,
          get: () => ({
            name,
            geomType: 3,
            fields: { count: () => 0 },
            features: { count: () => 1 },
          }),
        },
        close() {},
      };
    },
  };
}

describe('staged upload layer names', () => {
  const previous = process.env.STAGING_DIR;
  const dirs: string[] = [];
  let staging: IngestStagingService;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'gg-staging-spec-'));
    dirs.push(root);
    process.env.STAGING_DIR = root;
    staging = new IngestStagingService({
      shouldRun: () => false,
    } as unknown as LeaderElectionService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previous === undefined) delete process.env.STAGING_DIR;
    else process.env.STAGING_DIR = previous;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** What multer plus POST /ingest/stage do with a picked file. */
  async function stageUpload(originalName: string, body: string) {
    const dir = mkdtempSync(join(tmpdir(), 'gg-ingest-'));
    dirs.push(dir);
    const filePath = join(dir, serverUploadName(originalName));
    writeFileSync(filePath, body);
    return staging.stageFromPath({ filePath, originalName, ownerId: OWNER });
  }

  it('probes a staged parcels.geojson as parcels, not payload', async () => {
    const staged = await stageUpload(
      'parcels.geojson',
      '{"type":"FeatureCollection","features":[]}',
    );
    const ingest = new IngestService();
    jest
      .spyOn(ingest as unknown as { loadGdal: () => Promise<unknown> }, 'loadGdal')
      .mockResolvedValue(stemNamingGdal());
    const probe = await ingest.probeFileFromPath(staged.filePath);
    expect(probe.layers.map((l) => l.name)).toEqual(['parcels']);
  });

  it('labels a staged address CSV after the picked file', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/status')) return new Response('OK', { status: 200 });
      return new Response(JSON.stringify([{ lat: '38.8977', lon: '-77.0365' }]), {
        status: 200,
      });
    });
    const staged = await stageUpload(
      'parcels.csv',
      'name,address\nOffice,"1600 Pennsylvania Ave NW, Washington, DC"\n',
    );
    const ingest = new IngestService();
    const probe = await ingest.probeFileFromPath(staged.filePath);
    expect(probe.driver).toBe('csv-address');
    expect(probe.layers[0]?.name).toBe('parcels');

    // The import names the layer the probe reported.
    const meta = await ingest.streamLayerFromPath(
      staged.filePath,
      'parcels',
      async () => {},
      { layerLabel: staged.originalName },
    );
    expect(meta.layerName).toBe('parcels');
  });
});
