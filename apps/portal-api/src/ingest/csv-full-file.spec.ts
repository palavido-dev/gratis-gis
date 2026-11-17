// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exceedsAddressRowCap, IngestService } from './ingest.service.js';

/**
 * The CSV smart paths plan from the first 1 MiB of a file. A geomatch
 * import kept only the rows of that prefix (at most 5,000) and said it
 * succeeded; an address import kept at most 200.
 */
describe('CSV smart paths read the whole file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-ingest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const STATES = ['California', 'Texas', 'New York', 'Ohio', 'Utah'];

  async function stateCsv(rows: number): Promise<string> {
    const lines = ['State,Value'];
    for (let i = 0; i < rows; i++) lines.push(`${STATES[i % STATES.length]},${i}`);
    const path = join(dir, 'payload.csv');
    await writeFile(path, lines.join('\n') + '\n');
    return path;
  }

  it('imports every row of a state file past the 5,000 row plan', async () => {
    const path = await stateCsv(12_000);
    const ingest = new IngestService();
    let inserted = 0;
    let lastTotal = 0;
    const meta = await ingest.streamLayerFromPath(path, undefined, async (batch, progress) => {
      inserted += batch.length;
      lastTotal = progress.total;
    });
    expect(meta.driver).toBe('csv-geomatch');
    expect(inserted).toBe(12_000);
    expect(lastTotal).toBe(12_000);
  });

  it('probes the full row count, not the prefix count', async () => {
    const path = await stateCsv(12_000);
    const probe = await new IngestService().probeFileFromPath(path);
    expect(probe.layers[0]!.featureCount).toBe(12_000);
  });

  it('sends an address file with more rows than the geocoder takes to the table path', () => {
    const header = 'street,city\n';
    const few = header + '1 Main St,Springfield\n'.repeat(10);
    const many = header + '1 Main St,Springfield\n'.repeat(250);
    expect(exceedsAddressRowCap(few, Buffer.byteLength(few))).toBe(false);
    expect(exceedsAddressRowCap(many, Buffer.byteLength(many))).toBe(true);
    // A file larger than the 1 MiB prefix that was read.
    expect(exceedsAddressRowCap(few, 5 * 1024 * 1024)).toBe(true);
  });
});
