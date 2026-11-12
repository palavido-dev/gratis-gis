// SPDX-License-Identifier: AGPL-3.0-or-later
jest.mock('./basemap-source.js', () => ({
  isReachable: jest.fn(async () => true),
  resolveBasemapSource: jest.fn(async () => 'https://tiles.example/planet.pmtiles'),
}));

import {
  OfflinePackageWorker,
  parseRegionTiles,
  readAreas,
  redactUrls,
} from './offline-package.worker.js';

/**
 * The size guard is only as good as this parse. If the upstream CLI
 * changes its log wording, the guard has to fail loudly rather than
 * quietly reading zero and waving a continent through.
 */
describe('parseRegionTiles', () => {
  /** Verbatim from `pmtiles extract --dry-run` on 2026-08-24. */
  const REAL_OUTPUT = [
    '2026/08/24 16:38:51 extract.go:373: fetching 6 dirs, 6 chunks, 6 requests',
    '2026/08/24 16:38:56 extract.go:413: Region tiles 1683, result tile entries 1683',
    '2026/08/24 16:38:56 extract.go:422: fetching 1683 tiles, 76 chunks, 45 requests',
    '2026/08/24 16:38:56 extract.go:578: Completed in 5.63s with 4 download threads.',
    '2026/08/24 16:38:56 extract.go:583: Extract required 54 total requests.',
    '2026/08/24 16:38:56 extract.go:584: Extract transferred 9.0 MB for an archive size of 8.6 MB',
  ].join('\n');

  it('reads the count out of real CLI output', () => {
    expect(parseRegionTiles(REAL_OUTPUT)).toBe(1683);
  });

  it('takes the region count, not the other numbers on nearby lines', () => {
    // 'fetching 6 dirs' comes first and 'fetching 1683 tiles' comes
    // after; a looser pattern would happily return 6.
    expect(parseRegionTiles(REAL_OUTPUT)).not.toBe(6);
  });

  it('handles a zero-coverage region', () => {
    expect(
      parseRegionTiles('extract.go:413: Region tiles 0, result tile entries 0'),
    ).toBe(0);
  });

  it('returns null when the line is absent', () => {
    // Distinct from 0 on purpose. Conflating them would turn "the
    // tool changed its output" into "this area is empty", and the
    // caller treats the latter as a buildable answer.
    expect(parseRegionTiles('some other output entirely')).toBeNull();
    expect(parseRegionTiles('')).toBeNull();
  });
});

describe('redactUrls', () => {
  it('strips a presigned mirror URL down to its host', () => {
    // The exact leak the 2026-08-24 review found: the pmtiles CLI
    // echoes the archive URL in its errors, the URL is the
    // operator's mirror, and errorMessage goes to every org reader.
    const cliError =
      'pmtiles exited with code 1\n' +
      'fetching https://mirror.example.com/planet.pmtiles?X-Amz-Signature=SECRET&X-Amz-Credential=AKIA123: 403';
    const redacted = redactUrls(cliError);
    expect(redacted).toContain('mirror.example.com');
    expect(redacted).not.toContain('X-Amz-Signature');
    expect(redacted).not.toContain('SECRET');
    expect(redacted).not.toContain('planet.pmtiles');
  });

  it('strips basic-auth credentials embedded in the URL', () => {
    // `host` excludes userinfo by definition, which is the point.
    expect(redactUrls('failed: https://user:hunter2@minio.internal:9000/x')).toBe(
      'failed: minio.internal:9000',
    );
  });

  it('leaves text without URLs untouched', () => {
    const plain = 'This area needs 30,001 tiles, over the limit of 25,000.';
    expect(redactUrls(plain)).toBe(plain);
  });
});

describe('readAreas', () => {
  const good = {
    id: 'a1',
    name: 'North block',
    bbox: [-80, 38, -79, 39],
    minZoom: 0,
    maxZoom: 14,
  };

  it('reads areas off a data_collection', () => {
    expect(readAreas({ version: 1, offlineAreas: [good] })).toHaveLength(1);
  });

  it('tolerates every shape an older or hand-edited item can have', () => {
    expect(readAreas(null)).toEqual([]);
    expect(readAreas(undefined)).toEqual([]);
    expect(readAreas('nonsense')).toEqual([]);
    expect(readAreas({ version: 1 })).toEqual([]);
    expect(readAreas({ offlineAreas: 'not an array' })).toEqual([]);
  });

  it('drops entries that could not be built from', () => {
    const areas = readAreas({
      offlineAreas: [
        good,
        null,
        { id: 'no-bbox', name: 'x' },
        { name: 'no-id', bbox: [-80, 38, -79, 39] },
        { id: 'short-bbox', bbox: [-80, 38] },
      ],
    });
    expect(areas.map((a) => a.id)).toEqual(['a1']);
  });
});

describe('automatic refresh sweep', () => {
  const day = 86_400_000;
  const area = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    name: 'Town',
    bbox: [0, 0, 0.1, 0.1],
    minZoom: 0,
    maxZoom: 12,
    refreshDays: 1,
    ...over,
  });

  function worker(items: unknown[], rows: unknown[]) {
    const enqueue = jest.fn(async () => ({}));
    const prisma = {
      item: { findMany: jest.fn(async () => items) },
      offlinePackage: { findMany: jest.fn(async () => rows) },
    };
    const packages = { itemsWithPackages: jest.fn(async () => ['i1', 'i2']), enqueue };
    const w = new OfflinePackageWorker(prisma as never, {} as never, packages as never);
    const sweep = () => (w as unknown as { queueDueRefreshes(): Promise<void> }).queueDueRefreshes();
    return { sweep, enqueue };
  }

  const ready = (itemId: string, ageDays: number) => ({
    itemId,
    areaId: 'a1',
    status: 'ready',
    finishedAt: new Date(Date.now() - ageDays * day),
    createdAt: new Date(Date.now() - ageDays * day - 1000),
  });

  it('does not requeue an area whose automatic rebuild failed after the ready package', async () => {
    const { sweep, enqueue } = worker(
      [{ id: 'i1', orgId: 'o', ownerId: 'u', data: { offlineAreas: [area()] } }],
      [
        { itemId: 'i1', areaId: 'a1', status: 'failed', finishedAt: new Date(), createdAt: new Date(Date.now() - 60_000) },
        ready('i1', 3),
      ],
    );
    await sweep();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still refreshes an aged area with no newer failure', async () => {
    const { sweep, enqueue } = worker(
      [{ id: 'i1', orgId: 'o', ownerId: 'u', data: { offlineAreas: [area()] } }],
      [ready('i1', 3)],
    );
    await sweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a malformed area on one item does not stop the sweep for the next', async () => {
    const { sweep, enqueue } = worker(
      [
        { id: 'i1', orgId: 'o', ownerId: 'u', data: { offlineAreas: [area({ name: undefined })] } },
        { id: 'i2', orgId: 'o', ownerId: 'u', data: { offlineAreas: [area()] } },
      ],
      [ready('i1', 3), ready('i2', 3)],
    );
    await sweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0] as unknown as [{ itemId: string }])[0].itemId).toBe('i2');
  });
});
