// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildOfflineRecoveryZip } from './offline-export';
import type { PendingBlob, QueueRecord } from './offline-store';

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

function record(): QueueRecord {
  return {
    id: 'op-1',
    dataCollectionId: 'dc-1',
    op: 'insert',
    dataLayerId: 'layer-1',
    layerKey: 'points',
    globalId: '11111111-1111-1111-1111-111111111111',
    geometry: { type: 'Point', coordinates: [-80.1, 35.2] },
    properties: { note: 'hydrant' },
    queuedAt: '2026-11-08T12:00:00.000Z',
    schemaHash: 'abc',
    syncStatus: 'pending',
    ownerUserId: 'user-1',
  };
}

function photo(): PendingBlob {
  return {
    blobId: 'blob-1',
    dataCollectionId: 'dc-1',
    dataLayerId: 'layer-1',
    layerKey: 'points',
    globalId: '11111111-1111-1111-1111-111111111111',
    fileName: 'hydrant.png',
    mimeType: 'image/png',
    sizeBytes: PNG.byteLength,
    blob: new Blob([PNG], { type: 'image/png' }),
    capturedAt: '2026-11-08T12:00:00.000Z',
    ownerUserId: 'user-1',
  };
}

describe('buildOfflineRecoveryZip', () => {
  it('packs the edit and the photo bytes, not just the file name', async () => {
    const { filename, bytes } = await buildOfflineRecoveryZip({
      dataCollectionId: 'dc-1',
      deploymentTitle: 'Maple Street',
      userId: 'ada',
      exportedAt: '2026-11-08T15:00:00.000Z',
      records: [record()],
      blobs: [photo()],
    });
    expect(filename).toBe('pending-maple-street-ada-2026-11-08.zip');
    const dir = mkdtempSync(join(tmpdir(), 'gg-offline-zip-'));
    const zipPath = join(dir, filename);
    try {
      writeFileSync(zipPath, bytes);
      const listing = execFileSync('python3', [
        '-c',
        `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.namelist()))`,
        zipPath,
      ], { encoding: 'utf8' });
      expect(listing).toContain('pending-edits.json');
      expect(listing).toContain('files/blob-1/hydrant.png');
      const photoBytes = execFileSync('python3', [
        '-c',
        `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read('files/blob-1/hydrant.png'))`,
        zipPath,
      ]);
      expect(Buffer.from(photoBytes).equals(Buffer.from(PNG))).toBe(true);
      const manifest = JSON.parse(
        execFileSync('python3', [
          '-c',
          `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read('pending-edits.json'))`,
          zipPath,
        ]).toString('utf8'),
      ) as { records: Array<{ geometry: { coordinates: number[] } }>; files: Array<{ path: string }> };
      expect(manifest.records[0]?.geometry.coordinates).toEqual([-80.1, 35.2]);
      expect(manifest.files[0]?.path).toBe('files/blob-1/hydrant.png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
