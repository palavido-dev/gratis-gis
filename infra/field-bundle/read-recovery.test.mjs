// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOfflineRecovery } from './read-recovery.mjs';

const dir = mkdtempSync(join(tmpdir(), 'gg-field-'));
const manifest = {
  kind: 'gratisgis-offline-recovery',
  version: 1,
  dataCollectionId: 'dep-1',
  records: [{ id: 'q1', op: 'insert', globalId: 'g1', geometry: { type: 'Point', coordinates: [1, 2] } }],
  files: [{ path: 'files/b1/photo.bin', blobId: 'b1', fileName: 'photo.bin' }],
};
writeFileSync(join(dir, 'pending-edits.json'), JSON.stringify(manifest));
writeFileSync(join(dir, 'photo.bin'), Buffer.from([1, 2, 3, 4]));
execFileSync('python3', ['-c', `
import zipfile, sys
root, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, 'w') as z:
    z.write(root + '/pending-edits.json', 'pending-edits.json')
    z.write(root + '/photo.bin', 'files/b1/photo.bin')
`, dir, join(dir, 'bundle.zip')]);
const restored = readOfflineRecovery(readFileSync(join(dir, 'bundle.zip')));
assert.equal(restored.records[0].globalId, 'g1');
assert.equal(restored.records[0].geometry.coordinates[0], 1);
assert.deepEqual([...restored.files[0].bytes], [1, 2, 3, 4]);
assert.match(restored.note, /never saved this bundle/);
console.log('field bundle import ok');
