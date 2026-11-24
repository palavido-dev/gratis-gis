// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FakeS3 } from '../testing/fake-s3.js';
import { downloadChecked } from './offsite-download.js';

describe('downloadChecked', () => {
  it('stops as soon as an object is larger than its record, writing no more than the record allows', async () => {
    const s3 = new FakeS3();
    s3.objects.set('o', { body: randomBytes(4096), lastModified: new Date(), etag: '"o"' });
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-dl-'));
    try {
      const fh = await fs.promises.open(path.join(d, 'x'), 'wx+');
      try {
        await expect(
          downloadChecked(s3 as never, 'b', 'o', fh, { bytes: 100, sha256: '0'.repeat(64) }),
        ).rejects.toThrow(/larger than the 100 bytes its record says/);
      } finally {
        await fh.close();
      }
      expect(fs.statSync(path.join(d, 'x')).size).toBeLessThanOrEqual(100);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
